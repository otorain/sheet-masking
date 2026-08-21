import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

type SqliteDb = InstanceType<typeof Database>

let db: SqliteDb | null = null

/**
 * Lazily opens (and migrates) the SQLite database stored in the app's
 * `userData` directory.
 *
 * better-sqlite3 is a native module: it is rebuilt against Electron's ABI by
 * `electron-builder install-app-deps` (see the `postinstall` script) and can
 * therefore only be loaded from the main process, never from the renderer.
 */
export function getDb(): SqliteDb {
  if (!db) {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    db = new Database(path.join(dir, 'global-news.db'))
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        content    TEXT    NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `)
  }
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
