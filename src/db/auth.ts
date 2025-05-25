import * as crypto from 'crypto'
import { sql } from './db'

export type NewUser = {
  username: string,
  email: string,
  password: string,
  ip: string,
  token: string
}

export function userByName(username: string) : Promise<any> {
  return sql`select * from users
    where username=${ username }`
    .then(result => result[0] || null)
    .catch(err => null)
}

export function userById(id: string) : Promise<any> {
  return sql`select * from users
    where id=${ id }`
    .then(result => result[0] || null)
    .catch(err => null)
}

export function userByEmail(email: string) : Promise<any> {
  return sql`select * from users
    where email=${ email }`
    .then(result => result[0] || null)
    .catch(err => null)
}

export function userByToken(token: string) : Promise<any> {
  return sql`select * from users
    where lastToken=${ token }`
    .then(result => result[0] || null)
    .catch(err => null)
}

export function isEmailTaken(email: string) : Promise<any> {
  return sql`select * from users
    where email=${ email }`
    .then(result => result[0]?.email === email ? true : false)
    .catch(err => false)
}

export async function createUserAccount(user: NewUser) : Promise<any> {
  const passwordSalt = crypto.randomBytes(64).toString('base64')
  const passwordHash = await crypto.pbkdf2Sync(
    user.password, passwordSalt, 300000, 64, 'sha512'
  ).toString('hex')

  return sql`insert into users
    (username, email, passwordHash, passwordSalt, lastIp, perms, lastToken)
    values
    (${ user.username }, ${ user.email }, ${ passwordHash },
    ${ passwordSalt }, ${ user.ip }, 'player', ${ user.token })`
    .then(result => result[0] || null)
    .catch(err => null)
}

export async function updateUserLogin(
  username: string,
  token: string,
  ip: string
): Promise<any> {
  await sql`
    update users
    set lastToken=${token}, lastIp=${ip}
    where username=${username}
  `
}
