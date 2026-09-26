/**
 * The desktop host supervisor: at most one `dsh --profile web` host per app.
 * `ensure()` adopts a healthy host already serving the configured origin, or
 * spawns one and owns it; `stop()` kills only a spawned host, never one the
 * person started outside the app. Readiness is `host.describe` succeeding —
 * a bound port alone proves nothing, because another process may own it.
 * @module @deepseek-ai/dsh-desktop/host-supervisor
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { HostLaunch } from './launch.ts'
import { parseWebUrlLine } from './readiness.ts'

/** How the app came to use the host it reports. */
type HostOwnership = 'adopted' | 'spawned'

/** The ready host: its canonical loopback origin, how it was obtained, and its `host.describe` value. */
export interface HostHandle {
  readonly origin: string
  /**
   * The full readiness URL when the host published one (a per-launch token
   * query on current masters); the window loads this so the page can hand
   * the token in for its session auth.
   */
  readonly launchUrl: string
  readonly ownership: HostOwnership
  readonly describe: unknown
}

/** Readiness probe: resolves the `host.describe` value, rejects on any transport or RPC failure. */
export type ProbeOrigin = (origin: string) => Promise<unknown>

/** A spawned host process, reduced to the surface the supervisor drives. */
export interface HostChild {
  readonly pid: number | undefined
  /** Subscribe to the child's stdout/stderr lines (diagnostics and the URL line). */
  onLine(listener: (line: string) => void): void
  /** Subscribe to process exit; `code` is null when no exit code is available. */
  onExit(listener: (code: number | null) => void): void
  /** Terminate the process tree and resolve once it is gone. */
  kill(): Promise<void>
}

/** Factory for host children; injectable so tests drive the lifecycle without processes. */
export type SpawnHostChild = (launch: HostLaunch) => HostChild

/** Upper bound on captured child output kept for failure diagnostics. */
const OUTPUT_LIMIT_BYTES = 8192
/** Default ready budget for a spawned host. */
const DEFAULT_READY_TIMEOUT_MS = 20_000
/** Default probe poll interval while awaiting readiness. */
const DEFAULT_POLL_MS = 250
/** Grace before a SIGKILL escalates a terminate that the tree ignored. */
const KILL_GRACE_MS = 5_000

/**
 * Probe one origin with a real `host.describe` call — the shell's only direct
 * RPC, pinned to the same wire the browser client speaks (`POST
 * /api/<method>` with a client-request envelope and an ok-result response).
 * @param origin - base origin, for example `http://127.0.0.1:3080`.
 * @returns the parsed `host.describe` value.
 */
export async function probeOrigin(origin: string): Promise<unknown> {
  const body = {
    type: 'client-request',
    rpcId: `dsh-desktop-${randomUUID()}`,
    method: 'host.describe',
    payload: {},
  } as const
  const response = await fetch(new URL('api/host.describe', `${origin}/`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`host.describe HTTP ${response.status}`)
  const envelope = await response.json() as { result?: { ok?: boolean; value?: unknown } }
  if (envelope.result?.ok !== true) throw new Error('host.describe returned an error result')
  return envelope.result.value
}

/**
 * Pick the line to surface from failed child output: the loader's inner
 * `failed to import loader entry …` line names the broken plugin, while the
 * `cordis:include` wrapper around it names nothing actionable.
 * @param output - captured child output.
 * @returns the preferred diagnostic line, or the output tail when no inner cause is present.
 */
export function preferSpawnCause(output: string): string {
  const inner = output.split('\n').find(line =>
    line.includes('failed to import loader entry') || line.includes('Mismatched native'))
  if (inner !== undefined) return inner
  return output.length > 2048 ? `…${output.slice(-2048)}` : output
}

/** A host that never reached readiness; carries the captured child output for diagnosis. */
export class HostStartError extends Error {
  /** Captured child output, bounded to the diagnostics budget. */
  readonly output: string

  constructor(message: string, output: string) {
    super(message)
    this.name = 'HostStartError'
    this.output = output
  }
}

/** Supervisor configuration; every process-shaped seam is injectable for tests. */
export interface SupervisorOptions {
  /** Bind host; the desktop shell pins loopback. */
  readonly host: string
  /** Bind port; 0 spawns a private host with an OS-assigned port and skips the adopt probe. */
  readonly port: number
  /** Launch spec for a host this supervisor must spawn. */
  readonly launch: HostLaunch
  /** Readiness probe; defaults to the real `host.describe` call. */
  readonly probe?: ProbeOrigin
  /** Host child factory; defaults to the real `node:child_process` spawn. */
  readonly spawnChild?: SpawnHostChild
  /** Ready budget for a spawned host, in milliseconds. Default 20000. */
  readonly readyTimeoutMs?: number
  /** Probe poll interval while awaiting readiness, in milliseconds. Default 250. */
  readonly pollMs?: number
}

/** Append one line to the bounded capture, dropping oldest lines past the byte budget. */
function appendBounded(current: string, line: string): string {
  const next = current === '' ? line : `${current}\n${line}`
  if (next.length <= OUTPUT_LIMIT_BYTES) return next
  const kept = next.slice(next.length - OUTPUT_LIMIT_BYTES)
  const firstNewline = kept.indexOf('\n')
  return firstNewline === -1 ? kept : kept.slice(firstNewline + 1)
}

/** Sleep helper for the readiness poll loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Lifecycle owner of the app's single web host. One in-flight start at a
 * time: concurrent `ensure()` calls share one attempt, and `stop()` settles
 * that attempt before killing the child.
 */
export class HostSupervisor {
  private readonly host: string
  private readonly port: number
  private readonly launch: HostLaunch
  private readonly probe: ProbeOrigin
  private readonly spawnChild: SpawnHostChild
  private readonly readyTimeoutMs: number
  private readonly pollMs: number
  private handle: HostHandle | undefined
  private child: HostChild | undefined
  private starting: Promise<HostHandle> | undefined
  private stopped = false

  constructor(options: SupervisorOptions) {
    this.host = options.host
    this.port = options.port
    this.launch = options.launch
    this.probe = options.probe ?? probeOrigin
    this.spawnChild = options.spawnChild ?? spawnNodeHostChild
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
  }

  /**
   * Reach a ready host. Reuses a live handle that still probes healthy;
   * adopts a healthy host already on the configured origin; otherwise spawns
   * the launch and owns it.
   * @returns the ready host handle.
   */
  async ensure(): Promise<HostHandle> {
    const existing = this.handle
    if (existing !== undefined) {
      try {
        await this.probe(existing.origin)
        return existing
      } catch {
        this.handle = undefined
        await this.dropChild()
      }
    }
    if (this.starting !== undefined) return await this.starting
    const attempt = this.start()
    this.starting = attempt
    try {
      return await attempt
    } finally {
      this.starting = undefined
    }
  }

  /**
   * Tear the supervised host down. An adopted host is left running; a
   * spawned child is terminated with its process tree. Idempotent.
   */
  async stop(): Promise<void> {
    this.stopped = true
    const inFlight = this.starting
    if (inFlight !== undefined) await inFlight.catch(() => { /* the abort error is expected */ })
    await this.dropChild()
  }

  private async start(): Promise<HostHandle> {
    const fixedOrigin = this.port !== 0 ? `http://${this.host}:${String(this.port)}` : undefined
    if (fixedOrigin !== undefined) {
      const describe = await this.tryProbe(fixedOrigin)
      if (describe !== undefined) {
        this.handle = { origin: fixedOrigin, launchUrl: fixedOrigin, ownership: 'adopted', describe }
        return this.handle
      }
    }
    return await this.spawnAndAwait(fixedOrigin)
  }

  private async tryProbe(origin: string): Promise<unknown> {
    try {
      return await this.probe(origin)
    } catch {
      return undefined
    }
  }

  private async spawnAndAwait(fixedOrigin: string | undefined): Promise<HostHandle> {
    const child = this.spawnChild(this.launch)
    this.child = child
    let output = ''
    let lineOrigin: string | undefined
    let lineUrl: string | undefined
    let exitCode: number | null | undefined
    child.onLine((line) => {
      if (lineOrigin === undefined) {
        const url = parseWebUrlLine(line)
        if (url !== undefined) {
          lineOrigin = url.origin
          lineUrl = url.href
        }
      }
      output = appendBounded(output, line)
    })
    child.onExit((code) => { exitCode = code })
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      const origin = fixedOrigin ?? lineOrigin
      if (origin !== undefined) {
        const describe = await this.tryProbe(origin)
        if (describe !== undefined) {
          this.handle = { origin, launchUrl: lineUrl ?? origin, ownership: 'spawned', describe }
          return this.handle
        }
      }
      if (exitCode !== undefined) {
        const codeText = exitCode === null ? 'no exit code (signal or spawn failure)' : String(exitCode)
        throw new HostStartError(
          `dsh web host exited with ${codeText} before becoming ready: ${preferSpawnCause(output)}`,
          output,
        )
      }
      if (this.stopped) {
        await child.kill()
        throw new HostStartError('dsh web host startup aborted by shutdown', output)
      }
      if (Date.now() >= deadline) {
        await child.kill()
        throw new HostStartError(
          `dsh web host did not become ready within ${String(this.readyTimeoutMs)} ms: ${preferSpawnCause(output)}`,
          output,
        )
      }
      await delay(this.pollMs)
    }
  }

  private async dropChild(): Promise<void> {
    this.handle = undefined
    const child = this.child
    this.child = undefined
    if (child !== undefined) await child.kill().catch(() => { /* a child already gone needs no kill */ })
  }
}

/**
 * Spawn one host child with `node:child_process`: no shell, hidden Windows
 * console, line-split stdout/stderr, and a tree-wide terminate on kill —
 * `taskkill /T /F` on Windows, SIGTERM escalating to SIGKILL elsewhere.
 * @param launch - the resolved launch spec.
 * @returns the reduced child surface the supervisor drives.
 */
export function spawnNodeHostChild(launch: HostLaunch): HostChild {
  const child = spawn(launch.file, [...launch.args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...launch.cwd !== undefined && { cwd: launch.cwd },
    ...launch.env !== undefined && { env: { ...process.env, ...launch.env } },
  })
  const lineListeners: Array<(line: string) => void> = []
  const exitListeners: Array<(code: number | null) => void> = []
  const emitLine = (line: string): void => { for (const listener of lineListeners) listener(line) }
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', emitLine)
  }
  const emitExit = (code: number | null): void => { for (const listener of exitListeners) listener(code) }
  child.on('exit', emitExit)
  // A failed spawn (ENOENT…) never emits exit; surface it as line + exit so
  // the readiness loop fails fast instead of running out its budget.
  child.on('error', (error) => {
    emitLine(`spawn error: ${error.message}`)
    emitExit(null)
  })
  return {
    pid: child.pid,
    onLine: (listener) => { lineListeners.push(listener) },
    onExit: (listener) => { exitListeners.push(listener) },
    kill: () => killTree(child),
  }
}

/** Terminate one child and its process tree, resolving once the child is gone. */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => { if (!settled) { settled = true; resolve() } }
    child.once('exit', done)
    child.once('error', done)
    if (process.platform === 'win32' && child.pid !== undefined) {
      // SIGTERM cannot reach a Windows process tree; taskkill is the
      // tree-wide terminate, and the exit event confirms it landed.
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('exit', done)
      killer.on('error', done)
    } else {
      child.kill('SIGTERM')
    }
    setTimeout(() => { if (!settled) child.kill('SIGKILL') }, KILL_GRACE_MS).unref()
  })
}
