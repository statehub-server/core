export const log = (
  message: string,
  level: string = 'info',
  module: string = 'core',
  method: Function = console.log
) => method(`[${module}/${level}] ${message}`)

export const fatal = (
  message: string,
  module: string = 'core'
) => log(message, 'fatal', module, console.error)

export const error = (
  message: string,
  module: string = 'core'
) => log(message, 'error', module, console.error)

export const warn = (
  message: string,
  module: string = 'core'
) => log(message, 'warning', module, console.warn)
