import { WebSocket } from 'ws'

export interface IdentifiedWebSocket extends WebSocket {
  id: string
  userId?: string
  isLoggedIn?: boolean
}
