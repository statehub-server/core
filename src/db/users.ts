import { sql } from './db'
import { log } from '../logger'
import crypto from 'crypto'

export async function getAllUsers(): Promise<any[]> {
  return sql`
    SELECT u.id, u.username, u.email, u.createdAt, u.lastLogin,
           COALESCE(array_agg(up.permission) FILTER (WHERE up.permission IS NOT NULL), '{}') as permissions,
           EXISTS(SELECT 1 FROM oauthIdentities oi WHERE oi.userId = u.id) as hasOAuth
    FROM users u
    LEFT JOIN userPermissions up ON u.id = up.userId
    GROUP BY u.id, u.username, u.email, u.createdAt, u.lastLogin
    ORDER BY u.createdAt DESC
  `
    .then(result => result || [])
    .catch(err => {
      log('Database error! -- Unable to get all users.')
      return []
    })
}

export async function getUserById(userId: string): Promise<any> {
  return sql`
    SELECT u.id, u.username, u.email, u.createdAt, u.lastLogin,
           COALESCE(array_agg(up.permission) FILTER (WHERE up.permission IS NOT NULL), '{}') as permissions,
           EXISTS(SELECT 1 FROM oauthIdentities oi WHERE oi.userId = u.id) as hasOAuth
    FROM users u
    LEFT JOIN userPermissions up ON u.id = up.userId
    WHERE u.id = ${userId}
    GROUP BY u.id, u.username, u.email, u.createdAt, u.lastLogin
  `
    .then(result => result[0] || null)
    .catch(err => {
      log('Database error! -- Unable to get user by ID.')
      return null
    })
}

export async function getUserByUsername(username: string): Promise<any> {
  return sql`
    SELECT u.id, u.username, u.email, u.createdAt, u.lastLogin,
           COALESCE(array_agg(up.permission) FILTER (WHERE up.permission IS NOT NULL), '{}') as permissions,
           EXISTS(SELECT 1 FROM oauthIdentities oi WHERE oi.userId = u.id) as hasOAuth
    FROM users u
    LEFT JOIN userPermissions up ON u.id = up.userId
    WHERE u.username = ${username}
    GROUP BY u.id, u.username, u.email, u.createdAt, u.lastLogin
  `
    .then(result => result[0] || null)
    .catch(err => {
      log('Database error! -- Unable to get user by username.')
      return null
    })
}

export async function changeUserPassword(
  userId: string, 
  newPassword: string
): Promise<boolean> {
  const salt = crypto.randomBytes(64).toString('base64')
  const hash = crypto.pbkdf2Sync(newPassword, salt, 300000, 64, 'sha512').toString('hex')
  
  return sql`
    UPDATE users 
    SET passwordHash = ${hash}, passwordSalt = ${salt}
    WHERE id = ${userId}
  `
    .then(() => true)
    .catch(err => {
      log('Database error! -- Unable to change user password.')
      return false
    })
}

export async function grantPermissions(
  userId: string, 
  permissions: string[]
): Promise<boolean> {
  try {
    for (const permission of permissions) {
      // Check if permission already exists
      const existing = await sql`
        SELECT id FROM userPermissions 
        WHERE userId = ${userId} AND permission = ${permission}
      `
      
      if (existing.length === 0) {
        await sql`
          INSERT INTO userPermissions (userId, permission, minrole)
          VALUES (${userId}, ${permission}, '')
        `
      }
    }
    return true
  } catch (err) {
    log('Database error! -- Unable to grant permissions.')
    return false
  }
}

export async function ungrantPermissions(
  userId: string, 
  permissions: string[]
): Promise<boolean> {
  try {
    for (const permission of permissions) {
      await sql`
        DELETE FROM userPermissions
        WHERE userId = ${userId} AND permission = ${permission}
      `
    }
    return true
  } catch (err) {
    log('Database error! -- Unable to ungrant permissions.')
    return false
  }
}

export async function hasOAuthAccount(userId: string): Promise<boolean> {
  return sql`
    SELECT COUNT(*) as count FROM oauthIdentities WHERE userId = ${userId}
  `
    .then(result => result[0]?.count > 0)
    .catch(() => false)
}
