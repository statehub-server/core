import express from 'express'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import cors from 'cors'
import bodyParser from 'body-parser'
import crypto from 'crypto'
import 'dotenv/config'
import { log, warn } from './logger'
import { exitIfDbConnectionFailed, migrateDb } from './db/db' 
import authRouter from './routes/auth'
import {
  modules,
  loadAllModules,
  onRegisterModuleNamespaceRouter,
  wsCommandRegistry
} from './modules/modloader'
import { IdentifiedWebSocket } from './utils/identifiedws'

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })
const wsOnlineClients = new Set<IdentifiedWebSocket>()
const wsPendingRequests = new Map<string, { ws: WebSocket }>()

const originWhitelist = process.env.ORIGIN_WHITELIST?.split(',') || [] as string[]
app.use(cors({
  origin: (origin, callback) => {
    const whitelisted = originWhitelist.includes(origin as string)
    callback(null, whitelisted)
  }
}))
app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' }))
app.use(express.json({ limit: '2mb' }))

app.use('/auth', authRouter)
onRegisterModuleNamespaceRouter((namespace, router) => {
  app.use(`/${namespace}`, router)
})

wss.on('connection', (ws) => {
  const client = ws as IdentifiedWebSocket
  client.id = crypto.randomUUID()
  client.isLoggedIn = false
  wsOnlineClients.add(client)
  log(`New client connected (id=${client.id})`)

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString())
      const { command, payload = {}, id = crypto.randomUUID() } = data
      const moduleName = command.split('.')[0]
      const handler = wsCommandRegistry.get(command)
      const subprocess = modules.get(moduleName)
      
      if (!handler || !modules.get(moduleName))
        return

      const onMessage = (msg: any) => {
        if (msg.type === 'response' && msg.id === id) {
          subprocess?.off('message', onMessage)

          const response = JSON.stringify({ id: id, payload: msg.payload })
          if (handler.broadcast) {
            for (const otherClient of wsOnlineClients) {
              if (otherClient.readyState === ws.OPEN) {
                otherClient.send(response)
              }
            }
          } else {
            ws.send(response)
          }
        }
      }

      subprocess?.on('message', onMessage)

      subprocess?.send({
        type: 'invoke',
        id: id,
        handlerId: handler.handlerId,
        payload
      })
    } catch (e) {
      warn(`Malformed request received (invalid json)`)
    }
  }) 

  ws.on('close', () => {
    log(`Client ${client.id} disconnected`)
    wsOnlineClients.delete(client)
  })
})

exitIfDbConnectionFailed()
migrateDb()

loadAllModules()

const port = process.env.PORT || 3000
server.listen(port, () => {
  log(`Server running on http://localhost:${port}`)
})
