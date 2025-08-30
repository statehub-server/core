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
import serverInfoRouter from './routes/server-info'
import usersRouter from './routes/users'
import {
  modules,
  loadAllModules,
  onRegisterModuleNamespaceRouter,
  wsCommandRegistry,
  getModuleContext,
  notifyClientConnect,
  notifyClientDisconnect,
  unloadModule,
  disconnectClient
} from './modules/modloader'
import { IdentifiedWebSocket } from './utils/identifiedws'
import { userByToken } from './db/auth'
import { 
  addOnlinePlayer, 
  removeOnlinePlayer, 
  updatePlayerAuth
} from './utils/player-tracker'
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
app.use('/server', serverInfoRouter)
app.use('/users', usersRouter)
onRegisterModuleNamespaceRouter((namespace, router) => {
  app.use(`${namespace}`, authMiddleware, router)
})

function parseWebSocketMessage(message: any) {
  const data = JSON.parse(message.toString())
  return {
    command: data.command,
    payload: data.payload || {},
    id: data.id || crypto.randomUUID(),
    token: data.token || null
  }
}

async function authenticateUser(token: string) {
  if (!token) return null
  
  const secretKey = process.env.SECRET_KEY || ''
  try {
    verify(token, secretKey)
    const user = await userByToken(token)
    if (!user) return null
    
    return {
      ...user,
      passwordhash: undefined,
      passwordsalt: undefined,
      lastip: undefined,
    }
  } catch(e) {
    return null
  }
}

function validateWebSocketCommand(command: string) {
  if (typeof command !== 'string') return false
  
  const moduleName = command.startsWith('@') 
    ? command.split('.')[0] 
    : command.split('.')[0]
  const handler = wsCommandRegistry.get(command)
  
  return handler && modules.get(moduleName) 
    ? { moduleName, handler } 
    : false
}

function setupReplyHandler(
  moduleContext: any, 
  id: string, 
  handler: any, 
  ws: WebSocket, 
  clientId: string
) {
  let replyTimeoutId: NodeJS.Timeout
  
  const replyHandler = (data: { 
    msgId: string, 
    payload: any, 
    contentType?: string 
  }) => {
    if (data.msgId === id) {
      clearTimeout(replyTimeoutId)
      const responseData = { id: id, payload: data.payload }
      const response = JSON.stringify(responseData)
      
      ws.send(response)
      moduleContext.eventEmitter.off('reply', replyHandler)
    }
  }
  
  moduleContext.eventEmitter.on('reply', replyHandler)
  
  replyTimeoutId = setTimeout(() => {
    moduleContext.eventEmitter.off('reply', replyHandler)
  }, 30000)
  
  return { replyHandler, replyTimeoutId }
}

async function handleWebSocketCommand(
  data: any, 
  ws: WebSocket, 
  clientId: string
) {
  const { command, payload, id, token } = data
  
  const validation = validateWebSocketCommand(command)
  if (!validation) return
  
  const { moduleName, handler } = validation
  const user = await authenticateUser(token)
  
  if (user) {
    updatePlayerAuth(
      clientId,
      user.username || 'Unknown',
      user.id || 'Unknown'
    )
  }
  
  const moduleContext = getModuleContext(moduleName)
  if (!moduleContext) return
  
  const rpcHandler = moduleContext.handlers.get('rpc')
  if (!rpcHandler) return
  
  const { replyHandler, replyTimeoutId } = setupReplyHandler(
    moduleContext, 
    id, 
    handler, 
    ws, 
    clientId
  )
  
  try {
    const result = await rpcHandler({
      id: id,
      handlerId: handler.handlerId,
      socketId: clientId,
      payload: payload,
      user: user
    })
    
    if (result !== undefined) {
      clearTimeout(replyTimeoutId)
      moduleContext.eventEmitter.off('reply', replyHandler)
      
      const responseData = { id: id, payload: result }
      const response = JSON.stringify(responseData)
      
      ws.send(response)
    }
  } catch (error) {
    warn(`Error handling WebSocket command ${handler.handlerId}: ${error}`)
  }
}

wss.on('connection', (ws) => {
  const client = ws as IdentifiedWebSocket
  client.id = crypto.randomUUID()
  wsOnlineClients.add(client)
  clientsById.set(client.id, client)
  
  log(`New client connected (id=${client.id})`)
  
  addOnlinePlayer(client.id, false, null, null)
  notifyClientConnect(client.id)
  
  ws.on('message', async (message) => {
    try {
      const data = parseWebSocketMessage(message)
      await handleWebSocketCommand(data, ws, client.id)
    } catch (e) {
      warn(`Malformed request received (invalid json)`)
    }
  }) 
  
  ws.on('close', () => {
    log(`Client ${client.id} disconnected`)
    wsOnlineClients.delete(client)
    clientsById.delete(client.id)
    
    removeOnlinePlayer(client.id)
    notifyClientDisconnect(client.id)
  })
})

exitIfDbConnectionFailed()
migrateDb()

loadAllModules()

const port = process.env.PORT || 3000
server.listen(port, () => {
  log(`Server running on http://localhost:${port}`)
})
