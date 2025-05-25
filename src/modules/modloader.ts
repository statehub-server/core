import { fork, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Router } from 'express'
import { log, warn, error } from '../logger'

const modulesDir = path.join(os.homedir(), '.config', 'statehub', 'modules')
const modules = new Map<string, ChildProcess>()

interface ModuleManifest {
  name: string
  description?: string
  version?: string
  author?: string
  license?: string
  entryPoint?: string
  repo?: string
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
    loadModule(modulePath)
  }
  log(`Loaded ${moduleDirs.length} module(s).`)
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

  subprocess.on('exit', code => {
    log(`Module "${manifest.name}" exited with code ${code}`)
    modules.delete(manifest.name)
  })

  subprocess.on('message', msg => {
    const { type, payload } = msg as any

    if (type === 'register')
      registerModuleEndpoints(manifest.name, payload)
    else
      log(`Message from ${manifest.name}: ${JSON.stringify(msg)}`)
  })

  subprocess.send?.({
    type: 'init',
    payload: {
      pgUrl: process.env.PG_URL,
    }
  })

  modules.set(manifest.name, subprocess)
  log(`Module "${manifest.name}" loaded.`)
}

function registerModuleEndpoints(name: string, payload: any) {
  const { routes, commands } = payload
  const subprocess = modules.get(name)

  if (!subprocess)
    return

  const router = Router()

  for(const route of routes || []) {
    const { method, path, handlerId, auth } = route

    router[method](path, async (req, res) => {
      const requestId = crypto.randomUUID()

      const onMessage = (msg: any) => {
        if (msg.type === 'response' && msg.id === requestId) {
          subprocess.off('message', onMessage)
          res.status(msg.status || 200).json(msg.payload)
        }
      }

      subprocess.on('message', onMessage)

      subprocess.send({
        type: 'invoke',
        id: requestId,
        handlerId: handlerId,
        payload: {
          req: req,
          // user: auth ? req.user : undefined
        }
      })
    })
  }

  if (onRegisterRouter)
    onRegisterRouter(name, router)
}
