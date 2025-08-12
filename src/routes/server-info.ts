import { Router } from 'express'
import { manifests } from '../modules/modloader'
import { getOnlinePlayersInfo, getOnlinePlayersCount } from '../utils/player-tracker'

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

export default serverInfoRouter
