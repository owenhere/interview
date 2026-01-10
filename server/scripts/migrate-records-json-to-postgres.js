/* eslint-disable no-console */
const path = require('path')
const db = require('../db')
const { migrateRecordsJsonToPostgres } = require('../migrate')

async function main() {
  await db.initDb()
  const filePath = path.join(__dirname, '..', 'records.json')
  console.log(`Migrating records.json -> PostgreSQL from ${filePath}`)
  const r = await migrateRecordsJsonToPostgres({ recordsJsonPath: filePath })
  if (r.skipped) {
    console.log(`Skipped: ${r.reason}`)
    return
  }
  console.log(`Done. Migrated sessions: ${r.sessions}, files: ${r.files}, conversation messages: ${r.messages}.`)
}

main().catch((err) => {
  console.error('Migration failed:', err?.message || err)
  process.exit(1)
})


