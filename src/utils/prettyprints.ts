import { log } from '../logger'

export function initializationMessage() {
  log('---------------------------------')
  log('Initializing Statehub server core')
  log('---------------------------------')
}

export function crashedMessage(code) {
  log('--------------------------------------------------------------------')
  log(`A fatal error occurred and the server core exited with code ${code}`)
  log('*** The server crashed ***')
  log('Check the pm2 backend logs for more details.')
  log('https://github.com/statehub-server/core/issues')
  log('--------------------------------------------------------------------')
}
