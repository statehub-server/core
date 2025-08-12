interface UserInfo {
  loggedIn: boolean
  username: string | null
  userId: string | null
}

const onlinePlayersMap = new Map<string, UserInfo>()

export function addOnlinePlayer(
  socketId: string, 
  loggedIn: boolean = false, 
  username: string | null = null, 
  userId: string | null = null
) {
  onlinePlayersMap.set(socketId, {
    loggedIn,
    username,
    userId
  })
}

export function updatePlayerAuth(
  socketId: string, 
  username: string, 
  userId: string
) {
  const existing = onlinePlayersMap.get(socketId)
  if (existing) {
    onlinePlayersMap.set(socketId, {
      loggedIn: true,
      username,
      userId
    })
  }
}

export function removeOnlinePlayer(socketId: string) {
  onlinePlayersMap.delete(socketId)
}

export function getOnlinePlayersMap(): Map<string, UserInfo> {
  return onlinePlayersMap
}

export function getOnlinePlayersInfo(): UserInfo[] {
  return Array.from(onlinePlayersMap.values())
}

export function getOnlinePlayersCount(): number {
  return onlinePlayersMap.size
}

export function getLoggedInPlayersCount(): number {
  return Array.from(onlinePlayersMap.values())
    .filter(player => player.loggedIn).length
}
