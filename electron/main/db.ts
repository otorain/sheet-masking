import { app } from 'electron'
import path from 'node:path'
import { DataSource } from 'typeorm'
import { Note } from './entities/Note.js'

let dataSource: DataSource | null = null

/**
 * Lazily creates and initializes the TypeORM DataSource backed by
 * better-sqlite3 (native module, main process only). The database file lives
 * in the app's `userData` directory; schema is auto-synchronized (demo) and
 * WAL mode is enabled via the driver's `enableWAL` option.
 */
export async function getDataSource(): Promise<DataSource> {
  if (!dataSource) {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: path.join(app.getPath('userData'), 'global-news.db'),
      entities: [Note],
      synchronize: true,
      enableWAL: true,
    })
    await dataSource.initialize()
  }
  return dataSource
}

export async function closeDataSource(): Promise<void> {
  await dataSource?.destroy()
  dataSource = null
}
