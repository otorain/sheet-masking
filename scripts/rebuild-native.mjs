// Runs `electron-builder install-app-deps`, which rebuilds native modules
// (e.g. better-sqlite3) against the Electron ABI via @electron/rebuild.
//
// @electron/rebuild caches Electron headers in `~/.electron-gyp`. In
// environments where $HOME is read-only (e.g. CI sandboxes), that mkdir
// fails with ENOENT, so we fall back to a writable project-local HOME.
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = os.homedir()
let env = process.env

try {
  accessSync(home, constants.W_OK)
  mkdirSync(path.join(home, '.electron-gyp'), { recursive: true })
} catch {
  const fallbackHome = path.join(process.cwd(), '.home')
  mkdirSync(path.join(fallbackHome, '.electron-gyp'), { recursive: true })
  env = { ...process.env, HOME: fallbackHome }
  console.log(`[rebuild-native] $HOME is not writable; using ${fallbackHome}`)
}

const result = spawnSync(
  'electron-builder',
  ['install-app-deps'],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
)
process.exit(result.status ?? 1)
