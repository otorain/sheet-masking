import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {
  changePassword,
  getAppState,
  getCryptoContext,
  getRulesConfig,
  resetPassword,
  saveRulesConfig,
  setupPassword,
  unlockWithPassword,
} from './config.js'
import { analyzeFile, kindFromPath, processFile } from './sheet.js'
import { BUILTIN_RULES } from './rules.js'
import type { ProcessMode, ProcessSelections, RulesConfig } from '../shared/types.js'

// ExcelJS 全量加载整个工作簿为对象图（50 万行 × 15 列 ≈ 4-8GB 堆），
// 32GB 机器直接把主进程堆上限提到 12GB。必须在 app ready 之前调用。
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=12288')

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// Disable GPU Acceleration for Windows 7
if (process.platform === 'win32' && os.release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

async function createWindow() {
  // 默认应用菜单（File/Edit/View/…）无使用场景，完全移除（Alt 也唤不出）。
  // 输入框复制粘贴是系统/Chromium 原生能力，不依赖菜单，不受影响。
  Menu.setApplicationMenu(null)
  win = new BrowserWindow({
    title: '报表脱敏工具',
    icon: path.join(process.env.VITE_PUBLIC, process.platform === 'linux' ? 'logo.png' : 'favicon.ico'),
    webPreferences: {
      preload,
      // 渲染进程保持 sandbox：无 nodeIntegration、contextIsolation 开启。
      // 一切文件/加密操作都在主进程，经 contextBridge 暴露的
      // window.ipcRenderer.invoke 通信。
    },
  })

  if (VITE_DEV_SERVER_URL) { // #298
    win.loadURL(VITE_DEV_SERVER_URL)
    // Open devTool if the app is not packaged
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

// --------- 报表脱敏工具 IPC（主进程唯一文件/加密入口） ---------
ipcMain.handle('app:state', () => getAppState())

ipcMain.handle('app:set-password', (_event, password: unknown) => {
  if (getAppState() !== 'setup') throw new Error('已设置过密码，请使用修改密码')
  setupPassword(String(password))
})

ipcMain.handle('app:unlock', (_event, password: unknown) => {
  if (!unlockWithPassword(String(password))) throw new Error('密码错误')
})

ipcMain.handle('app:change-password', (_event, oldPassword: unknown, newPassword: unknown) => {
  if (!changePassword(String(oldPassword), String(newPassword))) throw new Error('原密码错误')
})

ipcMain.handle('app:reset-password', () => {
  resetPassword()
})

ipcMain.handle('rules:get', () => ({ config: getRulesConfig(), builtins: BUILTIN_RULES }))

ipcMain.handle('rules:save', (_event, config: unknown) => {
  saveRulesConfig(config as RulesConfig)
})

ipcMain.handle('file:analyze', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: '表格文件', extensions: ['xlsx', 'xls', 'csv'] }],
  })
  if (result.canceled || !result.filePaths[0]) return null
  return analyzeFile(result.filePaths[0], getRulesConfig())
})

ipcMain.handle(
  'file:reanalyze',
  (_event, filePath: string, headerRowOverrides: Record<string, number>) =>
    analyzeFile(filePath, getRulesConfig(), headerRowOverrides),
)

ipcMain.handle(
  'file:process',
  async (
    event,
    req: { filePath: string; mode: ProcessMode; selections: ProcessSelections },
  ) => {
    const ctx = getCryptoContext() // 未解锁先抛错，不弹保存框
    const kind = kindFromPath(req.filePath)
    const ext = `.${kind}`
    const base = path.basename(req.filePath, ext)
    const suffix = req.mode === 'encrypt' ? '已脱敏' : '已还原'
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(path.dirname(req.filePath), `${base}.${suffix}${ext}`),
    })
    if (result.canceled || !result.filePath) return null
    return processFile(req.filePath, req.mode, req.selections, result.filePath, ctx, (percent) =>
      event.sender.send('file:progress', percent),
    )
  },
)
