import { userByName, userByEmail } from '../db/auth'

export type Validator = () => Promise<Result>
export type Result = { ok: true } | { error: string }

export const validatePresence = (field: string, name: string): Result =>
  field ? { ok: true } : { error: `${name}Missing` }

export const validateUsernameFormat = (username: string): Result =>
  /^[a-zA-Z0-9_]+$/.test(username)
    ? { ok: true } : { error: 'invalidUsernameFormat' };

export const validateUsernameLength = (username: string): Result =>
  username.length >= 3 && username.length <= 20
    ? { ok: true } : { error: 'invalidUsernameLength' }

export const validateEmail = (email: string): Result =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? { ok: true }
    : { error: 'invalidEmail' }

export const validatePasswordMatch = (pass: string, repass: string): Result =>
  pass === repass ? { ok: true } : { error: 'passwordsDontMatch' }

export const validateUsernameNotTaken = (username: string): () => Promise<Result> =>
  () => userByName(username).then(user =>
    user ? { error: 'usernameTaken' } : { ok: true }
  )

export const validateEmailNotTaken = (email: string): () => Promise<Result> =>
  () => userByEmail(email).then(user =>
    user ? { error: 'emailTaken' } : { ok: true }
  )
