import { Router, Request, Response, NextFunction } from 'express'
import { verify, sign } from 'jsonwebtoken'
import crypto from 'crypto'
import {
  NewUser,
  userByToken,
  userByName,
  createUserAccount,
  updateUserLogin
} from '../db/auth'
import {
  Validator,
  validatePresence,
  validateUsernameFormat,
  validateUsernameLength,
  validateEmail,
  validatePasswordMatch,
  validateUsernameNotTaken,
  validateEmailNotTaken
} from '../utils/validators'

const authRouter = Router()

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.header('Authorization')?.split(' ')[1] ?? ''
  const secretKey = process.env.SECRET_KEY || ''

  if (!token)
    return next()
  
  verify(token, secretKey, async (err) => {
    if (err)
      return next()

    const user = await userByToken(token)
    if (!user)
      return next()

    ;(req as any).user = {
      ...user,
      passwordhash: undefined,
      passwordsalt: undefined,
      lastip: undefined,
    }
    next()
  })
}

authRouter.post('/verify', (req, res) : any => {
  const token = req.header('Authorization')?.split(' ')[1] || ''
  const secretKey = process.env.SECRET_KEY || ''
  const noAccess = {
    error: 'invalidToken',
    text: 'Invalid authorization token'
  }
  
  if (!token)
    return res.status(401).json(noAccess)
  
  verify(token, secretKey, async (err) => {
    if (err)
      return res.status(401).json(noAccess)
    
    const user = await userByToken(token)
    if (!user)
      return res.status(401).json(noAccess)
    
    return res.json({
      ok: true,
      ...user,
      passwordhash: undefined,
      passwordsalt: undefined,
      lastip: undefined,
    })
  })
})

authRouter.post('/login', async (req, res): Promise<any> => {
  const { username, password } = req.body
  const ip = typeof req.headers['x-forwarded-for'] === 'string'
  ? req.headers['x-forwarded-for'].split(',')[0]
  : req.socket.remoteAddress ?? ''
  const secretKey = process.env.SECRET_KEY || ''
  
  if (!username || !password) {
    return res.status(400).json({
      error: 'missingCredentials',
      text: 'Username and password are required'
    })
  }
  
  const user = await userByName(username)
  if (!user || !user.passwordhash || !user.passwordsalt) {
    return res.status(401).json({
      error: 'invalidCredentials',
      text: `Invalid username or password`
    })
  }
  
  const attemptedHash = crypto.pbkdf2Sync(
    password,
    user.passwordsalt,
    300000,
    64,
    'sha512'
  ).toString('hex')
  
  if (attemptedHash !== user.passwordhash) {
    return res.status(401).json({
      error: 'invalidCredentials',
      text: 'Invalid username or password'
    })
  }
  
  const payload = {
    username: user.username,
    ip: ip,
  }
  const token = sign(payload, secretKey, { expiresIn: '12h' })
  
  await updateUserLogin(user.username, token, ip)
  
  return res.json({
    ok: true,
    text: `Successfully logged in as ${username}`,
    user: {
      ...user,
      token: token,
      passwordhash: undefined,
      passwordsalt: undefined,
      lastip: undefined,
    }
  })
})

authRouter.post('/register', async (req, res): Promise<any> => {
  const { username, email, password, repassword } = req.body
  const ip = typeof req.headers['x-forwarded-for'] === 'string'
  ? req.headers['x-forwarded-for'].split(',')[0]
  : req.socket.remoteAddress ?? ''
  const secretKey = process.env.SECRET_KEY || ''
  
  const errorMessages = {
    usernameMissing: 'Invalid username',
    passwordMissing: 'Password is missing',
    repasswordMissing: 'Password confirmation is missing',
    emailMissing: 'You must provide an email address',
    invalidEmail: 'Invalid email address',
    passwordsDontMatch: 'Passwords don\'t match',
    invalidUsernameFormat: 'Username must contain only letters, numbers, and underscores',
    invalidUsernameLength: 'The username must be between 3 and 20 characters long',
    usernameTaken: 'Username already taken',
    emailTaken: 'Email address already in use'
  }
  
  const validators: Validator[] = [
    () => Promise.resolve(validatePresence(username, 'username')),
    () => Promise.resolve(validateUsernameFormat(username)),
    () => Promise.resolve(validateUsernameLength(username)),
    validateUsernameNotTaken(username),
    () => Promise.resolve(validatePresence(email, 'email')),
    () => Promise.resolve(validateEmail(email)),
    () => Promise.resolve(validatePresence(password, 'password')),
    () => Promise.resolve(validatePresence(repassword, 'repassword')),
    () => Promise.resolve(validatePasswordMatch(password, repassword)),
    validateEmailNotTaken(email)
  ]
  
  for (const validator of validators) {
    const result = await validator()
    if ('error' in result)
      return res.status(400).json({
      error: result.error,
      text: errorMessages[result.error]
    })
  }
  
  const tmpUser = {
    username: username,
    password: password,
    email: email,
    ip: ip,
  }
  const token = sign(tmpUser, secretKey, { expiresIn: '12h' })
  const user: NewUser = {
    ...tmpUser,
    token: token
  }
  
  await createUserAccount(user)
  return res.json({
    ok: true,
    text: `Account '${username}' successfully created`,
    user: user
  })
})

authRouter.post('/logout', async (req, res): Promise<any> => {
  const token = req.header('Authorization')?.split(' ')[1] || ''
  const ip = typeof req.headers['x-forwarded-for'] === 'string'
  ? req.headers['x-forwarded-for'].split(',')[0]
  : req.socket.remoteAddress ?? ''
  
  if (!token) {
    return res.status(401).json({
      error: 'missingToken',
      text: 'Authorization token is required'
    })
  }
  
  const user = await userByToken(token)
  
  if (!user) {
    return res.status(401).json({
      error: 'invalidToken',
      text: 'Invalid or expired token'
    })
  }
  
  await updateUserLogin(user.username, '', ip)
  
  return res.json({
    ok: true,
    text: 'Successfully logged out'
  })
})

export default authRouter
