import * as vm from 'vm'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Router } from 'express'
import { EventEmitter } from 'events'
import { log, warn, error, fatal } from '../logger'
import { sql } from '../db/db'
import { getOnlinePlayersMap } from '../utils/player-tracker'

interface ModuleManifest {
  name: string
  description?: string
  version?: string
  author?: string
  license?: string
  entryPoint?: string
  repo?: string
  dependencies?: string[]
  path?: string
}

interface ConsoleSettingsField {
  fieldName: string
  fieldLabel: string
  dataType: 'string' | 'number' | 'boolean' | 'color' | 'datetime' | 'multichoice' | 'textarea'
  dataList?: string[]
  options?: Array<{ key: string; val: string }>
  fieldProcessor: string
  defaultValue?: any
  min?: number
  max?: number
  required?: boolean
  description?: string
}

interface ConsoleSettings {
  fields: ConsoleSettingsField[]
}

interface ModuleContext {
  context: any
  manifest: ModuleManifest
  eventEmitter: EventEmitter
  handlers: Map<string, (...args: any[]) => any>
  consoleSettings?: ConsoleSettings
}

const modulesDir = path.join(os.homedir(), '.config', 'statehub', 'modules')
export const modules = new Map<string, ModuleContext>()
export const wsCommandRegistry = new Map<string, {
  moduleName: string
  handlerId: string
}>()
export const manifests = new Map<string, ModuleManifest>()
export const moduleConsoleSettings = new Map<string, ConsoleSettings>()

let onRegisterRouter:
((namespace: string, router: Router) => void) | null = null

export function onRegisterModuleNamespaceRouter(
  fn: (namespace: string, router: Router) => void
) {
  onRegisterRouter = fn
}

export function getModuleContext(moduleName: string): ModuleContext | null {
  return modules.get(moduleName) || null
}

export function getModuleConsoleSettings(moduleName: string): ConsoleSettings | null {
  return moduleConsoleSettings.get(moduleName) || null
}

function findAllModules(): Array<{ name: string; path: string }> {
  const modules: Array<{ name: string; path: string }> = []
  
  if (!fs.existsSync(modulesDir)) {
    return modules
  }
  
  function scanDirectory(dir: string, namespace?: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const entryPath = path.join(dir, entry.name)
        const manifestPath = path.join(entryPath, 'manifest.json')
        
        if (entry.name.startsWith('@') && !namespace) {
          scanDirectory(entryPath, entry.name)
        } else if (fs.existsSync(manifestPath)) {
          const moduleName = namespace ? `${namespace}/${entry.name}` : entry.name
          modules.push({ name: moduleName, path: entryPath })
        }
      }
    }
  }
  
  scanDirectory(modulesDir)
  return modules
}

function ensureModulesDirectory(): boolean {
  if (!fs.existsSync(modulesDir)) {
    warn('No modules directory found, creating one...')
    fs.mkdirSync(modulesDir, { recursive: true })
    return false
  }
  return true
}

function loadModuleManifests(moduleList: Array<{ name: string; path: string }>) {
  for (const module of moduleList) {
    const manifestPath = path.join(module.path, 'manifest.json')
    
    if (!fs.existsSync(manifestPath))
      continue

    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ModuleManifest
    const manifest = { ...rawManifest, path: module.path }
    manifests.set(manifest.name, manifest)
  }
}

export function loadAllModules() {
  log('Begin loading server modules')
  
  if (!ensureModulesDirectory()) {
    return
  }
  
  const moduleList = findAllModules()
  
  if (!moduleList.length) {
    log('No modules found.')
    return
  }
  
  loadModuleManifests(moduleList)

  const { sorted, skipped } = dependencyTopologicalSort()

  for (const name of sorted) {
    const path = manifests.get(name)?.path || ''
    loadModule(path)
  }

  log(`Module loader: ${ sorted.length } module(s) loaded, ${skipped.length} failed.`)
}

function dependencyTopologicalSort() {
  const sorted: string[] = []
  const skipped: string[] = []
  const visited = new Set<string>()
  const temp = new Set<string>()

  log('Resolving dependencies')

  const visit = (name: string) => {
    if (temp.has(name)) {
      error(`Circular dependency detected: ${name}`)
      process.exit(1)
    }

    if (!visited.has(name)) {
      temp.add(name)
      const mod = manifests.get(name)

      if (!mod) {
        error(`Missing module manifest: ${name}`)
        process.exit(1)
      }

      for (const dep of mod.dependencies || []) {
        if (!manifests.has(dep)) {
          warn(`Dependency ${dep} for ${name} not found, skipping...`)
          skipped.push(name)
          return
        }

        visit(dep)
      }
      temp.delete(name)
      visited.add(name)
      sorted.push(name)
    }
  }

  for (const name of manifests.keys())
    visit(name)

  return { sorted, skipped }
}

function readModuleManifest(modulePath: string): ModuleManifest | null {
  const manifestPath = path.join(modulePath, 'manifest.json')
  
  if (!fs.existsSync(manifestPath)) {
    warn(`Skipping ${path.basename(modulePath)}: No manifest.json found.`)
    return null
  }
  
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ModuleManifest
  } catch (err) {
    warn(`Skipping ${path.basename(modulePath)}: Invalid manifest.json - ${err}`)
    return null
  }
}

function executeModule(modulePath: string, entryPath: string, manifest: ModuleManifest) {
  log(`Loading module: ${manifest.name}`)
  
  const vmContext = createVMContext(modulePath, entryPath)
  const eventEmitter = new EventEmitter()
  const handlers = new Map<string, any>()
  
  vmContext.Statehub = createStatehubAPI(manifest, handlers, eventEmitter)
  
  try {
    const moduleCode = fs.readFileSync(entryPath, 'utf-8')
    vm.runInContext(moduleCode, vmContext)
    
    const moduleExports = vmContext.module.exports || vmContext.exports
    
    const moduleContext: ModuleContext = {
      context: vmContext,
      manifest,
      eventEmitter,
      handlers,
      consoleSettings: undefined
    }

    modules.set(manifest.name, moduleContext)
    
    callModuleLoadHandler(handlers, manifest.name)
    registerModuleRouter(moduleExports, manifest)
    setupModuleEventHandlers(eventEmitter, manifest.name)
    
    log(`Module ${manifest.name} loaded successfully`)
    
  } catch (err) {
    warn(`Failed to load module ${manifest.name}: ${err}`)
  }
}

function callModuleLoadHandler(handlers: Map<string, any>, moduleName: string) {
  const loadHandler = handlers.get('moduleLoad')
  if (!loadHandler) return
  
  try {
    const result = loadHandler(undefined)
    if (result && typeof result.then === 'function') {
      result.catch((error: any) => {
        warn(`Error in module load handler for ${moduleName}: ${error}`)
      })
    }
  } catch (error) {
    warn(`Error in module load handler for ${moduleName}: ${error}`)
  }
}

function registerModuleRouter(moduleExports: any, manifest: ModuleManifest) {
  if (!moduleExports.router || !onRegisterRouter) return
  
  const namespace = getModuleNamespace(manifest)
  const moduleName = getBaseModuleName(manifest)
  const routePath = namespace ? `/${namespace}/${moduleName}` : `/${moduleName}`
  
  onRegisterRouter(routePath, moduleExports.router)
}

function setupModuleEventHandlers(eventEmitter: EventEmitter, moduleName: string) {
  eventEmitter.on('sendToClient', (data) => {
    sendToTargetedClient(data.clientId, data.message)
  })

  eventEmitter.on('broadcastToClients', (data) => {
    broadcastToAllClients(data.message)
  })

  eventEmitter.on('disconnectClient', (data) => {
    disconnectTargetedClient(data.socketId)
  })
}

function validateModuleFiles(modulePath: string, manifest: ModuleManifest): string | null {
  const entryFile = manifest.entryPoint || 'dist/index.js'
  const entryPath = path.join(modulePath, entryFile)
  
  if (!fs.existsSync(entryPath)) {
    warn(`Skipping ${manifest.name}: Entry file ${entryFile} not found.`)
    return null
  }
  
  return entryPath
}

function createVMContext(modulePath: string, entryPath: string) {
  return vm.createContext({
    require,
    module: { exports: {} },
    exports: {},
    __dirname: modulePath,
    __filename: entryPath,
    console,
    Buffer,
    process: {
      env: process.env,
      cwd: () => modulePath,
      pid: process.pid
    },
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval
  })
}

function createStatehubAPI(
  manifest: ModuleManifest,
  handlers: Map<string, any>, 
  eventEmitter: EventEmitter
) {
  return {
    registerCommands: (commands: any[]) => {
      registerModuleCommands(manifest.name, commands)
    },
    
    registerConsoleSettings: (settings: ConsoleSettings) => {
      moduleConsoleSettings.set(manifest.name, settings)
    },
    
    onModuleLoad: (handler: () => void | Promise<void>) => {
      handlers.set('moduleLoad', () => handler())
    },
    
    onModuleUnload: (handler: () => void | Promise<void>) => {
      handlers.set('moduleUnload', () => handler())
    },
    
    sendMpcRequest: (target: string, command: string, args: any[], id: string) => {
      return handleMpcRequest(manifest.name, target, command, args, id)
    },
    
    onMpcRequest: (handler: (...args: any[]) => any) => {
      handlers.set('mpc', handler)
    },
    
    onRPCInvoke: (handler: (...args: any[]) => any) => {
      handlers.set('rpc', handler)
    },
    
    reply: (msgId: string, payload: any, contentType?: string) => {
      eventEmitter.emit('reply', { msgId, payload, contentType })
    },
    
    onClientConnect: (handler: (payload: any) => any) => {
      handlers.set('clientConnect', handler)
    },
    onClientDisconnect: (handler: (payload: any) => any) => {
      handlers.set('clientDisconnect', handler)
    },
    onWebSocketMessage: (handler: (payload: any) => any) => {
      handlers.set('webSocketMessage', handler)
    },
    sendToClient: (clientId: string, message: any) => {
      eventEmitter.emit('sendToClient', { clientId, message })
    },
    broadcastToClients: (message: any) => {
      eventEmitter.emit('broadcastToClients', { message })
    },
    disconnectClient: (socketId: string) => {
      eventEmitter.emit('disconnectClient', { socketId })
    },
    
    getOnlinePlayers: () => {
      return getOnlinePlayersMap()
    },
    
    getDatabase: () => sql,
    
    log: (message: string) => {
      log(`${message}`, 'info', manifest.name)
    },
    warn: (message: string) => {
      warn(`${message}`, manifest.name)
    },
    error: (message: string) => {
      error(`${message}`, manifest.name)
    }
  }
}

export function loadModule(modulePath: string) {
  const manifest = readModuleManifest(modulePath)
  if (!manifest) return
  
  const entryPath = validateModuleFiles(modulePath, manifest)
  if (!entryPath) return
  
  executeModule(modulePath, entryPath, manifest)
}

function getModuleNamespace(manifest: ModuleManifest) {
  return manifest.name.startsWith('@') ? manifest.name.split('/')[0] : null
}

function getBaseModuleName(manifest: ModuleManifest) {
  return manifest.name.startsWith('@') 
    ? manifest.name.split('/')[1] 
    : manifest.name
}

function buildCommandName(namespace: string | null, baseModuleName: string, 
                         command: string) {
  return namespace 
    ? `${namespace}/${baseModuleName}.${command}`
    : `${baseModuleName}.${command}`
}

function registerModuleCommands(moduleName: string, commands: any[]) {
  const manifest = manifests.get(moduleName)
  if (!manifest) return

  for (const command of commands) {
    const namespace = getModuleNamespace(manifest)
    const baseModuleName = getBaseModuleName(manifest)
    const fullCommand = buildCommandName(namespace, baseModuleName, command.command)
    
    wsCommandRegistry.set(fullCommand, {
      moduleName,
      handlerId: command.handlerId
    })
  }
}

function handleMpcRequest(
  fromModule: string,
  targetModule: string,
  command: string,
  args: any[],
  requestId: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = modules.get(targetModule)
    if (!target) {
      warn(`MPC target module "${targetModule}" not found`)
      reject(new Error(`Module "${targetModule}" not found`))
      return
    }
    
    const handler = target.handlers.get('mpc')
    if (handler) {
      try {
        const result = handler.apply(null, [command, ...args])
        
        if (result instanceof Promise) {
          result.then(resolve).catch(reject)
        } else {
          resolve(result)
        }
      } catch (error) {
        warn(`Error handling MPC request in module ${targetModule}: ${error}`)
        reject(error)
      }
    } else {
      reject(new Error(`No MPC handler found in module "${targetModule}"`))
    }
  })
}

function sendToTargetedClient(clientId: string, message: any) {
  const { getOnlineClients } = require('../index')
  const wsOnlineClients = getOnlineClients() as Set<any>
  
  for (const client of wsOnlineClients) {
    if (client.id === clientId && client.readyState === 1) {
      client.send(JSON.stringify({ 
        type: 'moduleMessage',
        payload: message
      }))
      break
    }
  }
}

function broadcastToAllClients(message: any) {
  const { getOnlineClients } = require('../index')
  const wsOnlineClients = getOnlineClients() as Set<any>
  
  for (const client of wsOnlineClients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ 
        type: 'moduleMessage',
        payload: message
      }))
    }
  }
}

function disconnectTargetedClient(socketId: string) {
  const { getOnlineClients } = require('../index')
  const wsOnlineClients = getOnlineClients() as Set<any>
  
  for (const client of wsOnlineClients) {
    if (client.id === socketId) {
      client.close(1000, JSON.stringify({
        reason: 'Disconnected by server module'
      }))
      break
    }
  }
}

function notifyModulesOfClientEvent(eventType: string, payload: any) {
  for (const [moduleName, moduleContext] of modules) {
    const handler = moduleContext.handlers.get(eventType)
    if (handler) {
      try {
        handler(payload)
      } catch (error) {
        warn(`Error handling ${eventType} in module ${moduleName}: ${error}`)
      }
    }
  }
}

export function notifyClientConnect(clientId: string) {
  notifyModulesOfClientEvent('clientConnect', { clientId })
}

export function notifyClientDisconnect(clientId: string) {
  notifyModulesOfClientEvent('clientDisconnect', { clientId })
}

export function disconnectClient(socketId: string) {
  disconnectTargetedClient(socketId)
}

function callModuleUnloadHandler(moduleContext: ModuleContext, moduleName: string) {
  const unloadHandler = moduleContext.handlers.get('moduleUnload')
  if (!unloadHandler) return
  
  try {
    const result = unloadHandler()
    if (result && typeof result.then === 'function') {
      result.catch((error: any) => {
        warn(`Error in module unload handler for ${moduleName}: ${error}`)
      })
    }
  } catch (error) {
    warn(`Error in module unload handler for ${moduleName}: ${error}`)
  }
}

function cleanupModuleRegistrations(moduleName: string) {
  modules.delete(moduleName)
  moduleConsoleSettings.delete(moduleName)
  
  for (const [command, registration] of wsCommandRegistry.entries()) {
    if (registration.moduleName === moduleName) {
      wsCommandRegistry.delete(command)
    }
  }
}

export function unloadModule(moduleName: string) {
  const moduleContext = modules.get(moduleName)
  if (!moduleContext) {
    warn(`Cannot unload module ${moduleName}: not found`)
    return
  }

  callModuleUnloadHandler(moduleContext, moduleName)
  cleanupModuleRegistrations(moduleName)
  log(`Module ${moduleName} unloaded`)
}
