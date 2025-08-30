import { Router, Request, Response } from 'express'
import { authMiddleware } from './auth'
import { 
  getAllUsers, 
  getUserById, 
  getUserByUsername, 
  changeUserPassword,
  grantPermissions,
  ungrantPermissions,
  hasOAuthAccount
} from '../db/users'
import { 
  banUserById, 
  banUserByName, 
  unbanUserById, 
  unbanUserByName 
} from '../db/bans'
import { disconnectClient } from '../modules/modloader'
import { getOnlinePlayersMap } from '../utils/player-tracker'

const usersRouter = Router()

const REQUIRED_PERMISSIONS = ['admin', 'dev', 'sysadmin', 'modc', 'superuser']
const PROTECTED_PERMISSIONS = ['admin', 'dev', 'sysadmin', 'modc']
const PERMISSION_MANAGEMENT_PERMISSIONS = ['admin', 'dev', 'sysadmin', 'superuser']

function checkPermissions(req: Request, res: Response, endpoint: string): boolean {
  const user = (req as any).user
  
  if (!user?.permissions) {
    res.status(404).send(`Cannot ${req.method} ${endpoint}`)
    return false
  }
  
  const userPermissions = Array.isArray(user.permissions) 
    ? user.permissions 
    : user.permissions ? [user.permissions] : []
  
  const hasPermission = REQUIRED_PERMISSIONS.some(permission => 
    userPermissions.includes(permission)
  )
  
  if (!hasPermission) {
    res.status(404).send(`Cannot ${req.method} ${endpoint}`)
    return false
  }
  
  return true
}

function checkPermissionManagement(req: Request, res: Response, endpoint: string): boolean {
  const user = (req as any).user
  
  if (!user?.permissions) {
    res.status(404).send(`Cannot ${req.method} ${endpoint}`)
    return false
  }
  
  const userPermissions = Array.isArray(user.permissions) 
    ? user.permissions 
    : user.permissions ? [user.permissions] : []
  
  const hasPermission = PERMISSION_MANAGEMENT_PERMISSIONS.some(permission => 
    userPermissions.includes(permission)
  )
  
  if (!hasPermission) {
    res.status(404).send(`Cannot ${req.method} ${endpoint}`)
    return false
  }
  
  return true
}

function isSuperuser(user: any): boolean {
  const userPermissions = Array.isArray(user.permissions) 
    ? user.permissions 
    : user.permissions ? [user.permissions] : []
  return userPermissions.includes('superuser')
}

function hasProtectedPermissions(permissions: string[]): boolean {
  return PROTECTED_PERMISSIONS.some(perm => permissions.includes(perm))
}

usersRouter.get('/all', authMiddleware, async (req: Request, res: Response): Promise<any> => {
  if (!checkPermissions(req, res, '/all')) return

  try {
    const users = await getAllUsers()
    const onlinePlayersMap = getOnlinePlayersMap()
    
    const usersWithOnlineStatus = users.map(user => ({
      ...user,
      isOnline: Array.from(onlinePlayersMap.values()).some(
        player => player.userId === user.id
      ),
      socketId: Array.from(onlinePlayersMap.entries()).find(
        ([, player]) => player.userId === user.id
      )?.[0] || null
    }))
    
    res.json({ users: usersWithOnlineStatus })
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' })
  }
})

usersRouter.get('/:username', authMiddleware, async (req: Request, res: Response): Promise<any> => {
  if (!checkPermissions(req, res, '/:username')) return

  try {
    const user = await getUserByUsername(req.params.username)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    const onlinePlayersMap = getOnlinePlayersMap()
    const isOnline = Array.from(onlinePlayersMap.values()).some(
      player => player.userId === user.id
    )
    const socketId = Array.from(onlinePlayersMap.entries()).find(
      ([, player]) => player.userId === user.id
    )?.[0] || null
    
    res.json({ 
      user: { 
        ...user, 
        isOnline, 
        socketId 
      } 
    })
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' })
  }
})

usersRouter.post('/ban', authMiddleware, async (req: Request, res: Response): Promise<any> => {
  if (!checkPermissions(req, res, '/ban')) return

  const { username, reason, expiresAt, permaban } = req.body
  const adminUser = (req as any).user
  
  if (!username || !reason) {
    return res.status(400).json({ error: 'Username and reason are required' })
  }
  
  if (username === 'admin') {
    return res.status(403).json({ error: 'Cannot ban admin user' })
  }
  
  try {
    const targetUser = await getUserByUsername(username)
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    if (hasProtectedPermissions(targetUser.permissions) && !isSuperuser(adminUser)) {
      return res.status(403).json({ 
        error: 'Cannot ban users with admin privileges' 
      })
    }
    
    const expirationDate = expiresAt ? new Date(expiresAt) : undefined
    await banUserByName(username, reason, adminUser.id, expirationDate, permaban)
    
    res.json({ success: true, message: `User ${username} has been banned` })
  } catch (error) {
    res.status(500).json({ error: 'Failed to ban user' })
  }
})

usersRouter.post('/unban', authMiddleware, async (req: Request, res: Response): Promise<any> => {
  if (!checkPermissions(req, res, '/unban')) return

  const { username } = req.body
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' })
  }
  
  try {
    await unbanUserByName(username)
    res.json({ success: true, message: `User ${username} has been unbanned` })
  } catch (error) {
    res.status(500).json({ error: 'Failed to unban user' })
  }
})

usersRouter.post('/kick', authMiddleware, async (req: Request, res: Response): Promise<any> => {
  if (!checkPermissions(req, res, '/kick')) return

  const { socketId, username } = req.body
  const adminUser = (req as any).user
  
  if (!socketId && !username) {
    return res.status(400).json({ error: 'Socket ID or username is required' })
  }
  
  try {
    let targetSocketId = socketId
    
    if (username) {
      if (username === 'admin') {
        return res.status(403).json({ error: 'Cannot kick admin user' })
      }
      
      const targetUser = await getUserByUsername(username)
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' })
      }
      
      if (hasProtectedPermissions(targetUser.permissions) && !isSuperuser(adminUser)) {
        return res.status(403).json({ 
          error: 'Cannot kick users with admin privileges' 
        })
      }
      
      const onlinePlayersMap = getOnlinePlayersMap()
      targetSocketId = Array.from(onlinePlayersMap.entries()).find(
        ([, player]) => player.userId === targetUser.id
      )?.[0]
      
      if (!targetSocketId) {
        return res.status(404).json({ error: 'User is not online' })
      }
    }
    
    disconnectClient(targetSocketId)
    res.json({ success: true, message: 'User has been kicked' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to kick user' })
  }
})

usersRouter.post('/changepassword', authMiddleware, async (req: Request, res: Response): Promise<any> => {
  if (!checkPermissions(req, res, '/changepassword')) return

  const { username, newPassword } = req.body
  const adminUser = (req as any).user
  
  if (!username || !newPassword) {
    return res.status(400).json({ error: 'Username and new password are required' })
  }
  
  try {
    const user = await getUserByUsername(username)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    if (user.hasoauth) {
      return res.status(400).json({ 
        error: 'Cannot change password for OAuth-based accounts' 
      })
    }
    
    if (username === 'admin' || user.permissions.includes('superuser')) {
      if (adminUser.username !== 'admin' || !isSuperuser(adminUser)) {
        return res.status(403).json({ 
          error: 'Only the admin account can change admin or superuser passwords' 
        })
      }
    }
    
    const success = await changeUserPassword(user.id, newPassword)
    if (success) {
      res.json({ success: true, message: 'Password changed successfully' })
    } else {
      res.status(500).json({ error: 'Failed to change password' })
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to change password' })
  }
})

usersRouter.post('/grant', authMiddleware, async (req: Request, res: Response): Promise<any> => {
  if (!checkPermissionManagement(req, res, '/grant')) return

  const { username, permissions } = req.body
  const adminUser = (req as any).user
  
  if (!username || !permissions || !Array.isArray(permissions)) {
    return res.status(400).json({ error: 'Username and permissions array are required' })
  }
  
  if (permissions.includes('superuser')) {
    return res.status(403).json({ 
      error: 'Superuser permission cannot be granted' 
    })
  }
  
  try {
    const user = await getUserByUsername(username)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    const success = await grantPermissions(user.id, permissions)
    if (success) {
      res.json({ success: true, message: 'Permissions granted successfully' })
    } else {
      res.status(500).json({ error: 'Failed to grant permissions' })
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to grant permissions' })
  }
})

usersRouter.post('/ungrant', authMiddleware, async (req: Request, res: Response): Promise<any> => {
  if (!checkPermissionManagement(req, res, '/ungrant')) return

  const { username, permissions } = req.body
  
  if (!username || !permissions || !Array.isArray(permissions)) {
    return res.status(400).json({ error: 'Username and permissions array are required' })
  }
  
  if (username === 'admin' && permissions.includes('superuser')) {
    return res.status(403).json({ 
      error: 'Cannot remove superuser permission from admin' 
    })
  }
  
  try {
    const user = await getUserByUsername(username)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    const success = await ungrantPermissions(user.id, permissions)
    if (success) {
      res.json({ success: true, message: 'Permissions removed successfully' })
    } else {
      res.status(500).json({ error: 'Failed to remove permissions' })
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove permissions' })
  }
})

export default usersRouter
