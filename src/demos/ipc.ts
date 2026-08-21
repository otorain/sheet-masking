
window.ipcRenderer.on('main-process-message', (_event, ...args) => {
  console.log('[Receive Main-process message]:', ...args)
})

// better-sqlite3 demo: the DB runs in the main process, so the renderer talks
// to it over IPC (see `ipcMain.handle('db:status')` in electron/main/index.ts).
window.ipcRenderer
  .invoke('db:status')
  .then((status) => {
    console.log('[DB status]:', status)
  })
  .catch((error) => {
    console.error('[DB status] failed:', error)
  })
