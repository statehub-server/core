import * as vm from 'vm'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { Router } from 'express'
import { EventEmitter } from 'events'
import { log, warn, error, fatal } from '../logger'
import { sql } from '../db/db'

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

interface ModuleContext {
  context: any
  manifest: ModuleManifest
  eventEmitter: EventEmitter
  handlers: Map<string, (...args: any[]) => any>
}

const modulesDir = path.join(os.homedir(), '.config', 'statehub', 'modules')
export const modules = new Map<string, ModuleContext>()
export const wsCommandRegistry = new Map<string, {
  moduleName: string
  handlerId: string
  broadcast: boolean
  auth: boolean
}>()
export const manifests = new Map<string, ModuleManifest>()

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

// Recursively find all modules in the modules directory
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
          // This is a namespace directory, scan inside it
          scanDirectory(entryPath, entry.name)
        } else if (fs.existsSync(manifestPath)) {
          // This is a module directory with manifest
          const moduleName = namespace ? `${namespace}/${entry.name}` : entry.name
          modules.push({ name: moduleName, path: entryPath })
        }
      }
    }
  }
  
  scanDirectory(modulesDir)
  return modules
}

export function loadAllModules() {
  log('Begin loading server modules')
  
  if (!fs.existsSync(modulesDir)) {
    warn('No modules directory found, creating one...')
    fs.mkdirSync(modulesDir, { recursive: true })
    return
  }
  
  const moduleList = findAllModules()
  
  if (!moduleList.length) {
    log('No modules found.')
    return
  }
  
  for (const module of moduleList) {
    const manifestPath = path.join(module.path, 'manifest.json')
    
    if (!fs.existsSync(manifestPath))
      continue

    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ModuleManifest
    const manifest = { ...rawManifest, path: module.path }
    manifests.set(manifest.name, manifest)
  }

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

export function loadModule(modulePath: string) {
  const manifestPath = path.join(modulePath, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    warn(`Skipping ${modulePath}: No manifest.json found.`)
    return
  }
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ModuleManifest
  const entryFile = manifest.entryPoint || 'dist/index.js'
  const entryPath = path.join(modulePath, entryFile)
  
  if (!fs.existsSync(entryPath)) {
    warn(`Skipping ${manifest.name}: Entry file ${entryFile} not found.`)
    return
  }

  log(`Loading module: ${manifest.name}`)

  const vmContext = vm.createContext({
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

  const eventEmitter = new EventEmitter()
  const handlers = new Map<string, (payload: any) => any>()

  vmContext.Statehub = {
    registerCommands: (commands: any[]) => {
      registerModuleCommands(manifest.name, commands)
    },
    
    sendMpcRequest: (target: string, command: string, args: any[], id: string) => {
      handleMpcRequest(manifest.name, target, command, args, id)
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
    
    onMessage: (type: string, handler: (payload: any) => any) => {
      handlers.set(type, handler)
    },
    sendMessage: (to: string, message: any, shardKey?: string) => {
      eventEmitter.emit('message', { to, message, shardKey })
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
    
    getDatabase: () => sql,
    
    log: (message: string) => {
      log(`[${manifest.name}] ${message}`)
    },
    warn: (message: string) => {
      warn(`[${manifest.name}] ${message}`)
    },
    error: (message: string) => {
      error(`[${manifest.name}] ${message}`)
    }
  }

  try {
    const moduleCode = fs.readFileSync(entryPath, 'utf-8')
    vm.runInContext(moduleCode, vmContext)
    
    const moduleExports = vmContext.module.exports || vmContext.exports
    
    const moduleContext: ModuleContext = {
      context: vmContext,
      manifest,
      eventEmitter,
      handlers
    }

    modules.set(manifest.name, moduleContext)

    if (moduleExports.router && onRegisterRouter) {
      const namespace = manifest.name.startsWith('@')
        ? manifest.name.split('/')[0]
        : null
      const moduleName = manifest.name.startsWith('@')
        ? manifest.name.split('/')[1]
        : manifest.name
      const routePath = namespace
        ? `/${namespace}/${moduleName}`
        : `/${moduleName}`
      onRegisterRouter(routePath, moduleExports.router)
    }

    eventEmitter.on('message', (data) => {
      handleModuleMessage(manifest.name, data.to, data.message, data.shardKey)
    })

    eventEmitter.on('sendToClient', (data) => {
      sendToTargetedClient(data.clientId, data.message)
    })

    eventEmitter.on('broadcastToClients', (data) => {
      broadcastToAllClients(data.message)
    })

    eventEmitter.on('reply', (data) => {
      handleRpcReply(data.msgId, data.payload, data.contentType)
    })

    log(`Module ${manifest.name} loaded successfully`)
  } catch (error) {
    warn(`Failed to load module ${manifest.name}: ${error}`)
  }
}

function registerModuleCommands(moduleName: string, commands: any[]) {
  const manifest = manifests.get(moduleName)
  if (!manifest) return

  for (const command of commands) {
    const namespace = manifest.name.startsWith('@')
    ? manifest.name.split('/')[0]
    : null
    const baseModuleName = manifest.name.startsWith('@')
    ? manifest.name.split('/')[1]
    : manifest.name
    const fullCommand = namespace 
      ? `${namespace}/${baseModuleName}.${command.command}`
      : `${baseModuleName}.${command.command}`
    
    wsCommandRegistry.set(fullCommand, {
      moduleName,
      handlerId: command.handlerId,
      broadcast: command.broadcast || false,
      auth: command.auth || false
    })
  }
}

function handleMpcRequest(
  fromModule: string,
  targetModule: string,
  command: string,
  args: any[],
  requestId: string
) {
  const target = modules.get(targetModule)
  if (!target) {
    warn(`MPC target module "${targetModule}" not found`)
    return
  }
  
  const handler = target.handlers.get('mpc')
  if (handler) {
    try {
      const result = handler.apply(null, [command, ...args])
      
      const sourceModule = modules.get(fromModule)
      if (sourceModule) {
        sourceModule.eventEmitter.emit('mpcResponse', { requestId, result })
      }
    } catch (error) {
      warn(`Error handling MPC request in module ${targetModule}: ${error}`)
    }
  }
}

function handleRpcReply(
  msgId: string,
  payload: any,
  contentType?: string
) {
  pendingReplies.set(msgId, { payload, contentType, timestamp: Date.now() })
  
  setTimeout(() => {
    pendingReplies.delete(msgId)
  }, 30000)
}

const pendingReplies = new Map<string, {
  payload: any,
  contentType?: string,
  timestamp: number
}>()

function handleModuleMessage(
  moduleName: string,
  to: string,
  message: any,
  shardKey?: string
) {
  const targetModule = modules.get(to)
  if (!targetModule) {
    warn(`Message target module "${to}" not found`)
    return
  }

  const handler = targetModule.handlers.get('message')
  if (handler) {
    try {
      handler({ from: moduleName, message, shardKey })
    } catch (error) {
      warn(`Error handling message in module ${to}: ${error}`)
    }
  }
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
