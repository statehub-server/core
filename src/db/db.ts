import postgres from 'postgres'
import path from 'path'
import fs from 'fs'
import { log, fatal } from '../logger'

export const sql = postgres(process.env.PG_URL || '', { onnotice: () => false })

export function exitIfDbConnectionFailed() {
  sql`select now()`
    .then(result => {
      log(`PostgreSQL connected: ${result[0].now}`)
    })
    .catch(error => {
      fatal(`PostgreSQL connection failed: ${error}`)
      process.exit(1)
    })
}

export function migrateDb() {
  const migrationFilename = path.join(__dirname, './migration.sql')
  fs.readFile(migrationFilename, 'utf-8', (err, data) => {
    if (err) {
      fatal(`Unable to read migration.sql: ${err}`)
      process.exit(1)
    }

    log('Running migration')
    sql.unsafe(data)
      .then(result => {
        log('Database ok')
      })
      .catch(err => {
        fatal(`Unable to run database migration: ${err}`)
        process.exit(1)
      })
  })
}
