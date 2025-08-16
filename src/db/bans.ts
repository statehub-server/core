import { sql } from './db'
import { log } from '../logger'

export type NewBan = {
  userId: string,
  reason: string,
  bannedBy?: string,
  expiresAt?: Date,
  permaban?: boolean
}

export function getBanByUserId(userId: string): Promise<any> {
  return sql`
    select * from bans
    where userId = ${userId} 
    and (permaban = true or (expiresAt is not null and expiresAt > now()))
  `
    .then(result => result[0] || null)
    .catch(err => log('Database error! -- Unable to read ban by user ID.'))
}

export function getBansByUserId(userId: string): Promise<any> {
  return sql`
    select * from bans
    where userId = ${userId}
    order by bannedAt desc
  `
    .then(result => result || [])
    .catch(err => log('Database error! -- Unable to read bans by user ID.'))
}

export async function banUserById(
  userId: string,
  reason: string,
  bannedBy?: string,
  expiresAt?: Date,
  permaban?: boolean
): Promise<any> {
  return sql`
    insert into bans (userId, reason, bannedBy, expiresAt, permaban)
    values (${userId}, ${reason}, ${bannedBy || null}, ${expiresAt || null}, 
            ${permaban || false})
  `
    .then(result => result[0] || null)
    .catch(err => log('Database error! -- Unable to ban user by ID.'))
}

export async function banUserByName(
  username: string,
  reason: string,
  bannedBy?: string,
  expiresAt?: Date,
  permaban?: boolean
): Promise<any> {
  const user = await sql`select id from users where username = ${username}`
  if (!user[0]) return null
  
  return banUserById(user[0].id, reason, bannedBy, expiresAt, permaban)
}

export async function banUserByEmail(
  email: string,
  reason: string,
  bannedBy?: string,
  expiresAt?: Date,
  permaban?: boolean
): Promise<any> {
  const user = await sql`select id from users where email = ${email}`
  if (!user[0]) return null
  
  return banUserById(user[0].id, reason, bannedBy, expiresAt, permaban)
}

export async function unbanUserById(userId: string): Promise<any> {
  return sql`
    delete from bans
    where userId = ${userId}
    and (permaban = true or (expiresAt is not null and expiresAt > now()))
  `
    .catch(err => log('Database error! -- Unable to unban user by ID.'))
}

export async function unbanUserByName(username: string): Promise<any> {
  const user = await sql`select id from users where username = ${username}`
  if (!user[0]) return null
  
  return unbanUserById(user[0].id)
}

export async function unbanUserByEmail(email: string): Promise<any> {
  const user = await sql`select id from users where email = ${email}`
  if (!user[0]) return null
  
  return unbanUserById(user[0].id)
}

export function isUserBanned(userId: string): Promise<boolean> {
  return sql`
    select id from bans
    where userId = ${userId} 
    and (permaban = true or (expiresAt is not null and expiresAt > now()))
  `
    .then(result => result.length > 0)
    .catch(err => {
      log('Database error! -- Unable to check if user is banned.')
      return false
    })
}
