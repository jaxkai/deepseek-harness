import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HostSupervisor, probeOrigin, spawnNodeHostChild } from '../src/host-supervisor.ts'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DIST_INDEX = join(REPO_ROOT, 'apps/web/dist/index.html')

/** Isolated harness homes created by the boot scenario, removed after each run. */
const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

// The web profile resolves the built frontend dist at activation and fails
// loud without it, so this suite runs only against a built checkout — the
// same self-skip contract as the keyless e2e lane.
const bootIt = existsSync(DIST_INDEX) ? it : it.skip

describe('dsh desktop host boot (real web composition)', () => {
  bootIt('spawns a private host, reaches readiness, and stops it', { timeout: 240_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-'))
    homes.push(home)
    const supervisor = new HostSupervisor({
      host: '127.0.0.1',
      port: 0,
      // Source launch per the dsh CLI contract (tsx's ESM-only hook); the
      // packaged app launches the built bin through resolveHostLaunch instead.
      launch: {
        file: process.execPath,
        args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--host', '127.0.0.1', '--port', '0'],
        cwd: REPO_ROOT,
        env: { DSH_HOME: home },
      },
      readyTimeoutMs: 180_000,
      pollMs: 250,
      spawnChild: spawnNodeHostChild,
    })
    const handle = await supervisor.ensure()
    expect(handle.ownership).toBe('spawned')
    expect(handle.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await expect(probeOrigin(handle.origin)).resolves.toBeTruthy()
    await supervisor.stop()
    await expect(probeOrigin(handle.origin)).rejects.toThrow()
  })
})
