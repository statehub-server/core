import * as crypto from 'crypto'
import { sql } from './db'
import { log } from '../logger'

export type NewUser = {
  username: string,
  email: string,
  password: string,
  ip: string,
  token?: string
}

export function userByName(username: string) : Promise<any> {
  return sql`
    select u.*, json_agg(up.permission) as permissions
    from users u
    left join userPermissions up on u.id = up.userId
    where u.username = ${username}
    group by u.id;
  `
    .then(result => result[0] || null)
    .catch(err => log('Database error! -- Unable to read user by name.'))
}

export function userById(id: string) : Promise<any> {
  return sql`
    select u.*, json_agg(up.permission) as permissions
    from users u
    left join userPermissions up on u.id = up.userId
    where u.id = ${id}
    group by u.id;
  `
    .then(result => result[0] || null)
    .catch(err => log('Database error! -- Unable to read user by ID.'))
}

export function userByEmail(email: string) : Promise<any> {
  return sql`
    select u.*, json_agg(up.permission) as permissions
    from users u
    left join userPermissions up on u.id = up.userId
    where u.email = ${email}
    group by u.id;
  `
    .then(result => result[0] || null)
    .catch(err => log('Database error! -- Unable to read user by email.'))
}

export function userByToken(token: string) : Promise<any> {
  return sql`
    select u.*, json_agg(up.permission) as permissions
    from users u
    left join userPermissions up on u.id = up.userId
    where u.lastToken = ${token}
    group by u.id;
  `
    .then(result => result[0] || null)
    .catch(err => log('Database error! -- Unable to read user by token.'))
}

export function isEmailTaken(email: string) : Promise<any> {
  return sql`select * from users
    where email=${ email }`
    .then(result => result[0]?.email === email ? true : false)
    .catch(err => log('Database error! -- Unable to check if email is taken.'))
}

export async function createUserAccount(user: NewUser) : Promise<any> {
  const passwordSalt = crypto.randomBytes(64).toString('base64')
  const passwordHash = await crypto.pbkdf2Sync(
    user.password, passwordSalt, 300000, 64, 'sha512'
  ).toString('hex')

  return sql`insert into users
    (username, email, passwordHash, passwordSalt, lastIp, lastToken)
    values
    (${ user.username }, ${ user.email }, ${ passwordHash },
    ${ passwordSalt }, ${ user.ip }, ${ user.token ?? '' })`
    .then(result => result[0] || null)
    .catch(err => log('Database error! -- Unable to insert user'))
}

export async function updateUserLogin(
  username: string,
  token: string,
  ip: string
): Promise<any> {
  await sql`
    update users
    set lastToken=${token}, lastIp=${ip}, lastLogin=NOW()
    where username=${username}
  `
}

export async function updateUserLoginById(
  userId: string,
  token: string,
  ip: string
): Promise<any> {
  await sql`
    update users
    set lastToken=${token}, lastIp=${ip}, lastLogin=NOW()
    where id=${userId}
  `
}
