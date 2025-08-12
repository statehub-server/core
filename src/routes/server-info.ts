import { Router, Request, Response } from 'express'
import { manifests } from '../modules/modloader'
import { getOnlinePlayersInfo, getOnlinePlayersCount, getOnlinePlayersMap } from '../utils/player-tracker'
import { authMiddleware } from './auth'

const serverInfoRouter = Router()

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
  const user = (req as any).user
  
  if (!user || !user.permissions) {
    return res.status(404).send('Cannot GET /players')
  }
  
  const requiredPermissions = ['admin', 'dev', 'sysadmin', 'modc', 'superuser']
  const userPermissions = Array.isArray(user.permissions) 
    ? user.permissions 
    : user.permissions ? [user.permissions] : []
  
  const hasPermission = requiredPermissions.some(permission => 
    userPermissions.includes(permission)
  )
  
  if (!hasPermission) {
    return res.status(404).send('Cannot GET /players')
  }

  const onlinePlayersMap = getOnlinePlayersMap()
  const players = Array.from(onlinePlayersMap.entries()).map(([socketId, playerInfo]) => ({
    socketId,
    loggedIn: playerInfo.loggedIn,
    username: playerInfo.username,
    userId: playerInfo.userId
  }))
  
  const response = {
    onlinePlayers: getOnlinePlayersCount(),
    players
  }
  
  res.json(response)
})

export default serverInfoRouter
