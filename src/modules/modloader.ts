import { fork, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { Router } from 'express'
import { log, warn, error, fatal } from '../logger'
import { authMiddleware } from '../routes/auth'
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
  multiInstanceSpawning?: boolean
  path?: string
}

interface ModuleInstance {
  process: ChildProcess
  instanceId: string
  manifest: ModuleManifest
}

interface LoadBalancingConfig {
  loadBalancing: Record<string, number>
}

const modulesDir = path.join(os.homedir(), '.config', 'statehub', 'modules')
const settingsPath = path.join(os.homedir(), '.config', 'statehub', 'settings.json')
export const modules = new Map<string, ModuleInstance[]>()
export const wsCommandRegistry = new Map<string, {
  moduleName: string
  handlerId: string
  broadcast: boolean
  auth: boolean
}>()
export const manifests = new Map<string, ModuleManifest>()
export const roundRobinCounters = new Map<string, number>()

let loadBalancingConfig: LoadBalancingConfig = { loadBalancing: {} }

function loadConfiguration() {
  if (fs.existsSync(settingsPath)) {
    try {
      const configData = fs.readFileSync(settingsPath, 'utf-8')
      loadBalancingConfig = JSON.parse(configData)
      log('Load balancing configuration loaded')
    } catch (error) {
      warn('Failed to parse settings.json, using defaults')
      loadBalancingConfig = { loadBalancing: {} }
    }
  } else {
    log('No settings.json found, using default configuration')
    loadBalancingConfig = { loadBalancing: {} }
  }
}

function hashShardKey(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

function getInstanceBySharding(moduleName: string, shardKey: string): ModuleInstance | null {
  const instances = modules.get(moduleName)
  if (!instances || instances.length === 0) return null
  
  const hash = hashShardKey(shardKey)
  const index = hash % instances.length
  return instances[index]
}

function getInstanceByRoundRobin(moduleName: string): ModuleInstance | null {
  const instances = modules.get(moduleName)
  if (!instances || instances.length === 0) return null
  
  const counter = roundRobinCounters.get(moduleName) || 0
  const index = counter % instances.length
  roundRobinCounters.set(moduleName, counter + 1)
  return instances[index]
}

export function getModuleInstance(
  moduleName: string,
  shardKey?: string
): ModuleInstance | null {
  if (shardKey) {
    return getInstanceBySharding(moduleName, shardKey)
  }
  return getInstanceByRoundRobin(moduleName)
}

let onRegisterRouter:
((namespace: string, router: Router) => void) | null = null

export function onRegisterModuleNamespaceRouter(
  fn: (namespace: string, router: Router) => void
) {
  onRegisterRouter = fn
}

export function loadAllModules() {
  log('Begin loading server modules')

  loadConfiguration()
  
  if (!fs.existsSync(modulesDir)) {
    warn('No modules directory found, creating one...')
    fs.mkdirSync(modulesDir)
    return
  }
  
  const moduleDirs = fs.readdirSync(modulesDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  
  if (!moduleDirs.length) {
    log('No modules found.')
    return
  }
  
  for (const dirent of moduleDirs) {
    const modulePath = path.join(modulesDir, dirent.name)
    const manifestPath = path.join(modulePath, 'manifest.json')
    
    if (!fs.existsSync(manifestPath))
      continue

    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ModuleManifest
    const manifest = { ...rawManifest, path: modulePath }
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
  
  const configuredInstances = loadBalancingConfig.loadBalancing[manifest.name] || 1
  const multiInstanceSupported = manifest.multiInstanceSpawning !== false
  
  let instanceCount = 1
  if (multiInstanceSupported) {
    instanceCount = configuredInstances
  } else if (configuredInstances > 1) {
    warn(`Module ${manifest.name} does not support multi-instance spawning, limiting to 1 instance`)
  }
  
  const instances: ModuleInstance[] = []
  
  for (let i = 0; i < instanceCount; i++) {
    const instanceId = `${manifest.name}-${i}`
    
    const subprocess = fork(entryPath, [], {
      cwd: modulePath,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })
    
    const moduleInstance: ModuleInstance = {
      process: subprocess,
      instanceId,
      manifest
    }
    
    const cleanup = (reason: string) => {
      log(`Module instance ${instanceId} unloaded (reason: ${reason})`)
      const moduleInstances = modules.get(manifest.name)
      if (moduleInstances) {
        const index = moduleInstances.findIndex(inst => inst.instanceId === instanceId)
        if (index !== -1) {
          moduleInstances.splice(index, 1)
          if (moduleInstances.length === 0) {
            modules.delete(manifest.name)
          }
        }
      }
      
      for (const key of wsCommandRegistry.keys()) {
        if (key.startsWith(`${manifest.name}.`)) {
          wsCommandRegistry.delete(key)
        }
      }
    }
    
    subprocess.on('exit', code => cleanup(`exited with error code ${code}`))
    subprocess.on('close', code => cleanup(`exited with error code ${code}`))
    subprocess.on('error', error => cleanup(`an error occurred "${error.message}"`))
    subprocess.on('disconnect', () => cleanup('disconnected'))
    
    subprocess.on('message', msg => handleModuleMessage(msg, manifest.name, instanceId))
    
    subprocess.send?.({
      type: 'init',
      payload: {
        instanceId
      }
    })
    
    instances.push(moduleInstance)
  }
  
  modules.set(manifest.name, instances)
  log(`Module "${manifest.name}" loaded with ${instanceCount} instance(s).`)
}

function handleModuleMessage(
  msg: any,
  moduleName: string,
  instanceId?: string
) {
  const { type, payload, level, message, id, to, isResult, shardKey } = msg
  
  switch (type) {
    case 'register':
      registerModuleEndpoints(moduleName, payload)
      break
    
    case 'log':
      switch (level) {
        case 'fatal': fatal(message, instanceId || moduleName); break
        case 'error': error(message, instanceId || moduleName); break
        case 'warning': warn(message, instanceId || moduleName); break
        default: log(message, level || 'info', instanceId || moduleName)
      }
      break
    
    case 'intermoduleMessage':
      const targetInstance = getModuleInstance(to, shardKey)
      if (!targetInstance)
        return

      targetInstance.process.send?.({
        type: isResult? 'mpcResponse' : 'mpcRequest',
        id,
        payload
      })
      break

    case 'databaseQuery':
      if (!id) {
        error(`Database query requires message id`)
        return
      }
      
      sql.unsafe(payload)
        .then(result => {
          const moduleInstances = modules.get(moduleName)
          const sourceInstance = moduleInstances?.find(inst => inst.instanceId === instanceId)
          sourceInstance?.process.send?.({
            type: 'databaseResult',
            id,
            payload: result
          })
        })
        .catch(err => {
          error(`Database query error: ${err.message}`, instanceId || moduleName)
          const moduleInstances = modules.get(moduleName)
          const sourceInstance = moduleInstances?.find(inst => inst.instanceId === instanceId)
          sourceInstance?.process.send?.({
            type: 'databaseError',
            id,
            payload: err.message
          })
        })
      break

    default:
      // log(`Message from ${instanceId || moduleName}: ${JSON.stringify(msg)}`)
      break
  }
}

function registerModuleEndpoints(name: string, payload: any) {
  const { routes, commands } = payload
  const moduleInstances = modules.get(name)
  
  if (!moduleInstances || moduleInstances.length === 0)
    return
  
  const router = Router()
  
  router.use((req, res, next) => authMiddleware(req, res, next))
  
  for(const route of routes || []) {
    const { rawMethod, path, handlerId, auth } = route
    const method = ['get', 'post', 'delete', 'put']
      .includes(rawMethod)? rawMethod : 'get'

    router[method](path, async (req, res) => {
      const requestId = crypto.randomUUID()
      const isMultipart = (req.headers['Content-Type'] || '')
        .includes('multipart/form-data')
      const timeoutMs = isMultipart ? 30_000 : 5_000 
      
      const shardKey = req.user?.id || req.headers['x-shard-key'] as string
      const selectedInstance = getModuleInstance(name, shardKey)
      
      if (!selectedInstance || selectedInstance.process.killed) {
        return res.status(503).json({
          error: 'Module service unavailable',
          module: name
        })
      }

      const timeout = setTimeout(() => {
        selectedInstance.process.off('message', onMessage)
        res.status(504).json({ error: 'timeout' })
      }, timeoutMs)
      
      const onMessage = (msg: any) => {
        clearTimeout(timeout)
        if (msg.type === 'response' && msg.id === requestId) {
          selectedInstance.process.off('message', onMessage)
          if (msg.contentType) {
            res.setHeader('Content-Type', msg.contentType)
            res.status(msg.status || 200).send(msg.payload)
          } else {
            res.status(msg.status || 200).json(msg.payload)
          }
        }
      }
      
      selectedInstance.process.on('message', onMessage)
      
      selectedInstance.process.send({
        type: 'invoke',
        id: requestId,
        handlerId: handlerId,
        payload: {
          query: req.query,
          params: req.params,
          body: req.body,
          headers: req.headers,
          user: auth ? req.user : undefined
        }
      })
    })
  }
  
  for (const cmd of commands) {
    const { command, handlerId, broadcast = false, auth = false } = cmd
    wsCommandRegistry.set(`${name}.${command}`, {
      moduleName: name,
      handlerId,
      broadcast,
      auth
    })
  }
  
  if (onRegisterRouter)
    onRegisterRouter(name, router)
}
