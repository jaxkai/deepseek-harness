/**
 * Electron main entry for the dsh desktop shell. Owns one supervised
 * `dsh --profile web` host and one unprivileged window pointed at it; the
 * GUI is the ordinary web client, unchanged. The renderer gets no Node
 * integration, no context bridge, no new windows, and navigation fenced to
 * the host origin — the loopback trust fence on `/api` is the only authority
 * the page needs.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, BrowserWindow } from 'electron'
import { HostSupervisor } from './host-supervisor.ts'
import { resolveHostLaunch } from './launch.ts'

/** Bind host for the supervised web host; loopback only, like `dsh web` itself. */
const HOST = '127.0.0.1'

/** Readiness budget: a Windows first boot (Defender scan plus plugin tree) is slower than POSIX. */
const READY_TIMEOUT_MS = 45_000

/**
 * Read the bind port from `DSH_DESKTOP_PORT`; 0 (the default) asks the OS for
 * a private free port, which keeps every app launch off shared ports.
 * @param env - the main process environment.
 * @returns the validated port number.
 */
function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.DSH_DESKTOP_PORT
  if (raw === undefined || raw === '') return 0
  if (!/^\d+$/.test(raw)) throw new Error(`DSH_DESKTOP_PORT must be a number, got ${JSON.stringify(raw)}`)
  return Number(raw)
}

/** Electron's own version string when the shell runs inside Electron, else undefined. */
const electronVersion = (process.versions as Record<string, string | undefined>).electron
const port = readPort(process.env)
const supervisor = new HostSupervisor({
  host: HOST,
  port,
  launch: resolveHostLaunch({
    platform: process.platform,
    execPath: process.execPath,
    electron: electronVersion !== undefined,
    ...process.env.DSH_DESKTOP_BIN !== undefined && { binOverride: process.env.DSH_DESKTOP_BIN },
    host: HOST,
    port,
  }),
  readyTimeoutMs: READY_TIMEOUT_MS,
})

let mainWindow: BrowserWindow | undefined

/**
 * Create the app window against the ready host. Navigation is fenced to the
 * host origin and every window-open attempt is denied, so the renderer stays
 * on the page the supervisor loaded.
 */
async function createWindow(): Promise<void> {
  const handle = await supervisor.ensure()
  const origin = new URL(handle.origin).origin
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== origin) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  mainWindow = window
  await window.loadURL(handle.origin)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = mainWindow
    if (window !== undefined) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })
  void app.whenReady().then(() => {
    void createWindow().catch((error: unknown) => {
      console.error('dsh-desktop: host startup failed:', error)
      app.quit()
    })
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  // Async teardown cannot run inside quit itself: hold the quit once, settle
  // the supervised host, then exit for real.
  let quitting = false
  app.on('will-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void supervisor.stop().catch(() => { /* shutdown proceeds regardless */ }).finally(() => { app.exit(0) })
  })
}
