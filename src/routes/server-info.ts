import { Router, Request, Response } from 'express'
import { manifests, getModuleConsoleSettings } from '../modules/modloader'
import { 
  getOnlinePlayersInfo, 
  getOnlinePlayersCount, 
  getOnlinePlayersMap 
} from '../utils/player-tracker'
import { authMiddleware } from './auth'

const serverInfoRouter = Router()

const REQUIRED_PERMISSIONS = ['admin', 'dev', 'sysadmin', 'modc', 'superuser']

function checkPermissions(req: Request, res: Response, endpoint: string): boolean {
  const user = (req as any).user
  
  if (!user?.permissions) {
    res.status(404).send(`Cannot GET ${endpoint}`)
    return false
  }
  
  const userPermissions = Array.isArray(user.permissions) 
    ? user.permissions 
    : user.permissions ? [user.permissions] : []
  
  const hasPermission = REQUIRED_PERMISSIONS.some(permission => 
    userPermissions.includes(permission)
  )
  
  if (!hasPermission) {
    res.status(404).send(`Cannot GET ${endpoint}`)
    return false
  }
  
  return true
}

serverInfoRouter.get('/info', (req, res) => {
  const onlinePlayersInfo = getOnlinePlayersInfo()
  
  const response = {
    onlinePlayers: getOnlinePlayersCount(),
    playerNames: onlinePlayersInfo
      .filter(player => player.loggedIn && player.username)
      .map(player => player.username),
    modules: Array.from(manifests.keys())
  }
  
  res.json(response)
})

serverInfoRouter.get('/players', authMiddleware, (req: Request, res: Response): any => {
  if (!checkPermissions(req, res, '/players')) return

  const onlinePlayersMap = getOnlinePlayersMap()
  const players = Array.from(onlinePlayersMap.entries()).map(([socketId, playerInfo]) => ({
    socketId,
    loggedIn: playerInfo.loggedIn,
    username: playerInfo.username,
    userId: playerInfo.userId
  }))
  
  res.json({
    onlinePlayers: getOnlinePlayersCount(),
    players
  })
})

serverInfoRouter.get('/modules', authMiddleware, (req: Request, res: Response): any => {
  if (!checkPermissions(req, res, '/modules')) return

  const moduleDetails = Array.from(manifests.entries()).map(([moduleName, manifest]) => ({
    name: moduleName,
    displayName: manifest.name || moduleName,
    version: manifest.version || '1.0.0',
    author: manifest.author || 'Unknown',
    description: manifest.description || '',
    dependencies: manifest.dependencies || [],
    dependencyCount: (manifest.dependencies || []).length
  }))
  
  res.json({
    modules: moduleDetails,
    totalModules: moduleDetails.length
  })
})

function handleModuleSettings(req: Request, res: Response, moduleName: string) {
  const settings = getModuleConsoleSettings(moduleName)
  
  if (!settings) {
    return res.status(404).json({ error: 'Module settings not found' })
  }
  
  res.json({ moduleName, settings })
}

serverInfoRouter.get('/modsettings/:moduleName', authMiddleware, 
  (req: Request, res: Response): any => {
    if (!checkPermissions(req, res, '/modsettings')) return
    handleModuleSettings(req, res, req.params.moduleName)
  }
)

serverInfoRouter.get('/modsettings/:namespace/:moduleName', authMiddleware, 
  (req: Request, res: Response): any => {
    if (!checkPermissions(req, res, '/modsettings')) return
    const { namespace, moduleName } = req.params
    handleModuleSettings(req, res, `${namespace}/${moduleName}`)
  }
)

export default serverInfoRouter
