import express from 'express'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import cors from 'cors'
import bodyParser from 'body-parser'
import crypto from 'crypto'
import { verify } from 'jsonwebtoken'
import 'dotenv/config'
import { log, warn } from './logger'
import { exitIfDbConnectionFailed, migrateDb } from './db/db' 
import authRouter, { authMiddleware } from './routes/auth'
import oauth2Router from './routes/oauth2'
import {
  modules,
  loadAllModules,
  onRegisterModuleNamespaceRouter,
  wsCommandRegistry,
  getModuleContext
} from './modules/modloader'
import { IdentifiedWebSocket } from './utils/identifiedws'
import { userByToken } from './db/auth'
import {
  crashedMessage,
  initializationMessage
} from './utils/prettyprints'

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })
const wsOnlineClients = new Set<IdentifiedWebSocket>()
const clientsById = new Map<string, IdentifiedWebSocket>()

export function getOnlineClients() {
  return wsOnlineClients
}

initializationMessage()

process.on('exit', code => {
  wsOnlineClients.forEach((client) =>
    client.close(1000, JSON.stringify({
      reason: 'Server closed.'
    })
  ))

  if (code !== 0)
    crashedMessage(code)
  else
    log('Shutting down gracefully')
})

const originWhitelist = process.env.ORIGIN_WHITELIST?.split(',') || [] as string[]
app.use(cors({
  origin: (origin, callback) => {
    const whitelisted = originWhitelist.includes(origin as string)
    callback(null, whitelisted)
  }
}))
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }))
app.use(express.json({ limit: '8mb' }))

app.use('/auth', authRouter)
app.use('/oauth', oauth2Router)
onRegisterModuleNamespaceRouter((namespace, router) => {
  app.use(`/${namespace}`, authMiddleware, router)
})

function sendWebSocketResponse(
  response: string, 
  target: string, 
  isBroadcast: boolean, 
  senderWs: WebSocket, 
  senderId: string
) {
  if (target === 'broadcast' || isBroadcast) {
    for (const client of wsOnlineClients) {
      if (client.readyState === 1) {
        client.send(response)
      }
    }
    return
  }
  
  if (target === 'self' || target === senderId) {
    senderWs.send(response)
    return
  }
  
  const targetClient = clientsById.get(target)
  if (targetClient && targetClient.readyState === 1) {
    targetClient.send(response)
  } else {
    senderWs.send(response)
  }
}

wss.on('connection', (ws) => {
  const client = ws as IdentifiedWebSocket
  client.id = crypto.randomUUID()
  wsOnlineClients.add(client)
  clientsById.set(client.id, client)
  log(`New client connected (id=${client.id})`)
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString())
      const {
        command,
        payload = {},
        id = crypto.randomUUID(),
        token = null,
        target = 'self'
      } = data

      if (typeof data.command !== 'string')
        return

      const moduleName = command.startsWith('@')
        ? command.split('/')[1]?.split('.')[0]
        : command.split('.')[0]
      const handler = wsCommandRegistry.get(command)
      const secretKey = process.env.SECRET_KEY || ''
      if (payload.user)
        payload.user = undefined

      if (token) {
        try {
          verify(token, secretKey)
          const user = await userByToken(token)
          if (!user)
            return

          payload.user = {
            ...user,
            passwordhash: undefined,
            passwordsalt: undefined,
            lastip: undefined,
          }
        } catch(e) {}
      }
      
      if (!handler || !modules.get(moduleName))
        return
      
      const moduleContext = getModuleContext(moduleName)
      if (!moduleContext) {
        return
      }
      
      const rpcHandler = moduleContext.handlers.get('rpc')
      if (rpcHandler) {
        try {
          const result = await rpcHandler({
            id: id,
            handlerId: handler.handlerId,
            payload: {
              query: {},
              params: {},
              body: payload,
              headers: {},
              user: payload.user
            }
          })
          
          if (result !== undefined) {
            const responseData = { id: id, payload: result }
            const response = JSON.stringify(responseData)
            
            sendWebSocketResponse(
              response,
              target,
              handler.broadcast,
              ws,
              client.id
            )
          }
        } catch (error) {
          warn(`Error handling WebSocket command ${handler.handlerId}: ${error}`)
        }
      }
    } catch (e) {
      warn(`Malformed request received (invalid json)`)
    }
  }) 
  
  ws.on('close', () => {
    log(`Client ${client.id} disconnected`)
    wsOnlineClients.delete(client)
    clientsById.delete(client.id)
  })
})

exitIfDbConnectionFailed()
migrateDb()

loadAllModules()

const port = process.env.PORT || 3000
server.listen(port, () => {
  log(`Server running on http://localhost:${port}`)
})
