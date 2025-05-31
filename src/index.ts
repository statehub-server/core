import express from 'express'
import http from 'http'
import { WebSocketServer } from 'ws'
import cors from 'cors'
import bodyParser from 'body-parser'
import 'dotenv/config'
import { log } from './logger'
import { exitIfDbConnectionFailed, migrateDb } from './db/db' 
import authRouter from './routes/auth'
import { loadAllModules, onRegisterModuleNamespaceRouter } from './modules/modloader'

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

const originWhitelist = process.env.ORIGIN_WHITELIST?.split(',') || [] as string[]
app.use(cors({
  origin: (origin, callback) => {
    const whitelisted = originWhitelist.includes(origin as string)
    callback(null, whitelisted)
  }
}))
app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' }))
app.use(express.json({ limit: '2mb' }))
 
wss.on('connection', (ws) => {
  log('WebSocket client connected')

  ws.on('message', (message) => {
    log('Received:', message.toString())

    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === ws.OPEN) {
        client.send(message.toString())
      }
    })
  })

  ws.on('close', () => {
    log('WebSocket client disconnected')
  })
})

app.use('/auth', authRouter)
onRegisterModuleNamespaceRouter((namespace, router) => {
  app.use(`/${namespace}`, router)
})

exitIfDbConnectionFailed()
migrateDb()

loadAllModules()

const port = process.env.PORT || 3000
server.listen(port, () => {
  log(`Server running on http://localhost:${port}`)
})
