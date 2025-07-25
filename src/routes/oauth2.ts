import { Router, Request, Response, NextFunction } from 'express'
import { verify, sign } from 'jsonwebtoken'
import crypto from 'crypto'
import { error } from '../logger'
import { createUserAccount, updateUserLogin, userByEmail } from '../db/auth'
import { sql } from '../db/db'

const oauth2Router = Router()

function generateSecurePassword() {
  return crypto.randomBytes(32).toString('hex')
}

function usernameFromEmail(email: string) {
  return email.split('@')[0]
}

async function registerUserOAuth2(email: string, provider: string, providerId: string, ip: string) {
  const secretKey = process.env.SECRET_KEY || ''
  const username = usernameFromEmail(email)
  const password = generateSecurePassword()
  
  const tmpUser = { username, password, email, ip }
  const token = sign(tmpUser, secretKey, { expiresIn: '12h' })
  
  await createUserAccount({ ...tmpUser, token })
  
  const user = await userByEmail(email)
  await sql`
    insert into oauthIdentities (userId, provider, providerId)
    values (${user.id}, ${provider}, ${providerId})
  `
  
  return {
    ok: true,
    text: `Account '${username}' successfully created`,
    user: {
      ...user,
      token,
      passwordhash: undefined,
      passwordsalt: undefined,
      lastip: undefined
    }
  }
}

async function loginUserOAuth2(user: any, ip: string) {
  const secretKey = process.env.SECRET_KEY || ''
  const payload = { username: user.username, ip }
  const token = sign(payload, secretKey, { expiresIn: '12h' })
  
  await updateUserLogin(user.username, token, ip)
  
  return {
    ok: true,
    text: `Successfully logged in as ${user.username}`,
    user: {
      ...user,
      token,
      passwordhash: undefined,
      passwordsalt: undefined,
      lastip: undefined
    }
  }
}

oauth2Router.post('/google/device', (req, res): any => {
  const params = new URLSearchParams({
    client_id: process.env.OAUTH_GOOGLE_CLIENT_ID_DEVICE ?? '',
    scope: 'openid email profile'
  })

  fetch('https://oauth2.googleapis.com/device/code', {
    method: 'post',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  .then(response => response.json())
  .then(data => res.json(data))
  .catch(error => {
    error(`Unable to generate Google OAuth2 device code: ${error.toString()}`)
    res.status(500).json({
      error: 'oauth2DeviceFlowError',
      text: 'Unable to generate Google OAuth2 device code'
    })
  })
})

async function exchangeGoogleDeviceCode(deviceCode: string) {
  const params = new URLSearchParams({
    client_id: process.env.OAUTH_GOOGLE_CLIENT_ID_DEVICE ?? '',
    client_secret: process.env.OAUTH_GOOGLE_CLIENT_SECRET_DEVICE ?? '',
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  })

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  return response.json()
}

oauth2Router.post('/google/device/poll', async (req, res): Promise<any> => {
  try {
    const { deviceCode } = req.body
    const ip = typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0]
      : req.socket.remoteAddress ?? ''

    const tokenData = await exchangeGoogleDeviceCode(deviceCode)

    if (tokenData.error) {
      switch(tokenData.error) {
        case 'authorization_pending':
          return res.status(428).json({
            error: 'authorizationPending',
            text: 'Waiting for authorization...'
          })
        case 'slow_down':
          return res.status(429).json({
            error: 'slowDown',
            text: 'Please wait before polling again'
          })
        case 'invalid_device_code':
          return res.status(400).json({
            error: 'invalidDeviceCode',
            text: 'The device code is invalid'
          })
      }
    }

    const userData = await fetchGoogleUserInfo(tokenData.access_token)
    const result = await handleOAuth2User(
      userData.email,
      'google_device',
      userData.id,
      ip
    )

    return res.json(result)
  } catch (err) {
    error(`Google device OAuth2 error: ${err}`)
    return res.status(500).json({
      error: 'oauth2Error',
      text: 'Failed to authenticate with Google device flow'
    })
  }
})

oauth2Router.post('/google/web', (req, res): any => {
  const redirectUrl = `${process.env.OAUTH_GOOGLE_REDIRECT_URL}`
  const params = new URLSearchParams({
    client_id: process.env.OAUTH_GOOGLE_CLIENT_ID_WEB ?? '',
    redirect_uri: redirectUrl,
    response_type: 'code',
    scope: 'openid email profile'
  })
  
  res.json({
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  })
})

async function exchangeGoogleCode(code: string, redirectUri: string) {
  const params = new URLSearchParams({
    client_id: process.env.OAUTH_GOOGLE_CLIENT_ID_WEB ?? '',
    client_secret: process.env.OAUTH_GOOGLE_CLIENT_SECRET_WEB ?? '',
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  return response.json()
}

async function fetchGoogleUserInfo(accessToken: string) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  return response.json()
}

async function handleOAuth2User(email: string, provider: string, providerId: string, ip: string) {
  const existingUser = await userByEmail(email)
  const oauthUser = existingUser ? await sql`
    select * from oauthIdentities 
    where userId=${existingUser.id} and provider=${provider}
  `.then(r => r[0]) : null

  if (existingUser && oauthUser) {
    return loginUserOAuth2(existingUser, ip)
  }
  return registerUserOAuth2(email, provider, providerId, ip)
}

oauth2Router.post('/google/web/callback', async (req, res): Promise<any> => {
  try {
    const { code } = req.body
    const ip = typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0]
      : req.socket.remoteAddress ?? ''
    const redirectUrl = `${process.env.OAUTH_GOOGLE_REDIRECT_URL}`

    const tokenData = await exchangeGoogleCode(code, redirectUrl)
    const userData = await fetchGoogleUserInfo(tokenData.access_token)
    const result = await handleOAuth2User(userData.email, 'google_web', userData.id, ip)

    return res.json(result)
  } catch (err) {
    error(`Google OAuth2 error: ${err}`)
    return res.status(500).json({
      error: 'oauth2Error',
      text: 'Failed to authenticate with Google'
    })
  }
})

oauth2Router.post('/discord/web', (req, res): any => {
  const redirectUrl = `${process.env.OAUTH_DISCORD_REDIRECT_URL}`
  const params = new URLSearchParams({
    client_id: process.env.OAUTH_DISCORD_CLIENT_ID ?? '',
    redirect_uri: redirectUrl,
    response_type: 'code',
    scope: 'identify email'
  })
  
  res.json({
    url: `https://discord.com/api/oauth2/authorize?${params.toString()}`
  })
})

async function exchangeDiscordCode(code: string, redirectUri: string) {
  const params = new URLSearchParams({
    client_id: process.env.OAUTH_DISCORD_CLIENT_ID ?? '',
    client_secret: process.env.OAUTH_DISCORD_CLIENT_SECRET ?? '',
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })

  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  return response.json()
}

async function fetchDiscordUserInfo(accessToken: string) {
  const response = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  return response.json()
}

oauth2Router.post('/discord/web/callback', async (req, res): Promise<any> => {
  try {
    const { code } = req.body
    const ip = typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0]
      : req.socket.remoteAddress ?? ''
    const redirectUrl = `${process.env.OAUTH_DISCORD_REDIRECT_URL}`

    const tokenData = await exchangeDiscordCode(code, redirectUrl)
    const userData = await fetchDiscordUserInfo(tokenData.access_token)
    const result = await handleOAuth2User(userData.email, 'discord_web', userData.id, ip)

    return res.json(result)
  } catch (err) {
    error(`Discord OAuth2 error: ${err}`)
    return res.status(500).json({
      error: 'oauth2Error',
      text: 'Failed to authenticate with Discord'
    })
  }
})

export default oauth2Router
