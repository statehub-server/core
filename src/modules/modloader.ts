import { fork, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { Router } from 'express'
import { log, warn, error, fatal } from '../logger'
import { authMiddleware } from '../routes/auth'

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

const modulesDir = path.join(os.homedir(), '.config', 'statehub', 'modules')
export const modules = new Map<string, ChildProcess>()
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

export function loadAllModules() {
  log('Begin loading server modules')
  
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
  
  const subprocess = fork(entryPath, [], {
    cwd: modulePath,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  })
  
  const cleanup = (reason: string) => {
    log(`Module ${manifest.name} unloaded (reason: ${reason})`,)
    modules.delete(manifest.name)
    
    for (const key of wsCommandRegistry.keys())
      if (key.startsWith(`${manifest.name}.`))
        wsCommandRegistry.delete(key)
  }
  
  subprocess.on('exit', code => cleanup(`exited with error code ${code}`))
  subprocess.on('close', code => cleanup(`exited with error code ${code}`))
  subprocess.on('error', error => cleanup(`an error occurred "${error.message}"`))
  subprocess.on('disconnect', () => cleanup('disconnected'))
  
  subprocess.on('message', msg => handleModuleMessage(msg, manifest.name))
  
  subprocess.send?.({
    type: 'init',
    payload: {
      pgUrl: process.env.PG_URL,
    }
  })
  
  modules.set(manifest.name, subprocess)
  log(`Module "${manifest.name}" loaded.`)
}

function handleModuleMessage(
  msg: any,
  moduleName: string
) {
  const { type, payload, level, message, id, to, isResult } = msg
  
  switch (type) {
    case 'register':
      registerModuleEndpoints(moduleName, payload)
      break
    
    case 'log':
      switch (level) {
        case 'fatal': fatal(message, moduleName); break
        case 'error': error(message, moduleName); break
        case 'warning': warn(message, moduleName); break
        default: log(message, level || 'info', moduleName)
      }
      break
    
    case 'intermoduleMessage':
      const target = modules[to]
      if (!target)
        return

      target.send?.({
        type: isResult? 'mpcResponse' : 'mpcRequest',
        id,
        payload
      })

      break

    default:
      // log(`Message from ${moduleName}: ${JSON.stringify(msg)}`)
      break
  }
}

function registerModuleEndpoints(name: string, payload: any) {
  const { routes, commands } = payload
  const subprocess = modules.get(name)
  
  if (!subprocess)
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
      
      if (!subprocess || subprocess.killed) {
        return res.status(503).json({
          error: 'Module service unavailable',
          module: name
        })
      }

      const timeout = setTimeout(() => {
        subprocess.off('message', onMessage)
        res.status(504).json({ error: 'timeout' })
      }, timeoutMs)
      
      const onMessage = (msg: any) => {
        clearTimeout(timeout)
        if (msg.type === 'response' && msg.id === requestId) {
          subprocess.off('message', onMessage)
          if (msg.contentType) {
            res.setHeader('Content-Type', msg.contentType)
            res.status(msg.status || 200).send(msg.payload)
          } else {
            res.status(msg.status || 200).json(msg.payload)
          }
        }
      }
      
      subprocess.on('message', onMessage)
      
      subprocess.send({
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
