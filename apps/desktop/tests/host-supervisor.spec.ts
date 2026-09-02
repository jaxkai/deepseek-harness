import { describe, expect, it, vi } from 'vitest'
import type { HostLaunch } from '../src/launch.ts'
import { type HostChild, HostStartError, HostSupervisor, preferSpawnCause } from '../src/host-supervisor.ts'

/** Scriptable stand-in for a spawned host child. */
class FakeChild implements HostChild {
  readonly pid = 4242
  killed = false
  private readonly lines: Array<(line: string) => void> = []
  private readonly exits: Array<(code: number | null) => void> = []

  onLine(listener: (line: string) => void): void { this.lines.push(listener) }
  onExit(listener: (code: number | null) => void): void { this.exits.push(listener) }

  emitLine(line: string): void { for (const listener of this.lines) listener(line) }
  emitExit(code: number | null): void { for (const listener of this.exits) listener(code) }

  async kill(): Promise<void> {
    this.killed = true
    this.emitExit(null)
  }
}

/** A probe the test flips between refusing and healthy. */
function controllableProbe() {
  const calls: string[] = []
  let healthy = false
  const setHealthy = (value: boolean): void => { healthy = value }
  const probe = vi.fn(async (origin: string): Promise<unknown> => {
    calls.push(origin)
    if (!healthy) throw new Error('connection refused')
    return { serverInfo: { name: 'deepseek-harness' } }
  })
  return { probe, calls, setHealthy }
}

const LAUNCH: HostLaunch = { file: 'node', args: ['bin.js', '--profile', 'web'] }

/** A supervisor over scripted seams with a 1 ms poll so tests settle immediately. */
function makeSupervisor(options: {
  probe: ReturnType<typeof controllableProbe>['probe']
  spawnChild: (launch: HostLaunch) => HostChild
  port: number
  readyTimeoutMs: number
}): HostSupervisor {
  return new HostSupervisor({
    host: '127.0.0.1',
    launch: LAUNCH,
    pollMs: 1,
    probe: options.probe,
    spawnChild: options.spawnChild,
    port: options.port,
    readyTimeoutMs: options.readyTimeoutMs,
  })
}

/** A spawn seam that records every FakeChild it creates. */
function recordingSpawn(children: FakeChild[]): (launch: HostLaunch) => HostChild {
  return () => { const child = new FakeChild(); children.push(child); return child }
}

describe('HostSupervisor', () => {
  it('adopts a healthy host on the configured origin without spawning', async () => {
    const { probe, setHealthy } = controllableProbe()
    setHealthy(true)
    const spawns: FakeChild[] = []
    const sut = makeSupervisor({ probe, port: 3080, readyTimeoutMs: 1000, spawnChild: recordingSpawn(spawns) })
    const handle = await sut.ensure()
    expect(handle).toMatchObject({ origin: 'http://127.0.0.1:3080', ownership: 'adopted' })
    expect(spawns).toHaveLength(0)
    await sut.stop()
  })

  it('spawns when no healthy host serves the configured origin', async () => {
    const { probe, setHealthy } = controllableProbe()
    const children: FakeChild[] = []
    const sut = makeSupervisor({ probe, port: 3080, readyTimeoutMs: 1000, spawnChild: recordingSpawn(children) })
    const attempt = sut.ensure()
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    setHealthy(true)
    const handle = await attempt
    expect(handle).toMatchObject({ origin: 'http://127.0.0.1:3080', ownership: 'spawned' })
  })

  it('skips the adopt probe for port 0 and reads the URL line for the origin', async () => {
    const { probe, calls, setHealthy } = controllableProbe()
    const children: FakeChild[] = []
    const sut = makeSupervisor({ probe, port: 0, readyTimeoutMs: 1000, spawnChild: recordingSpawn(children) })
    const attempt = sut.ensure()
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    expect(probe).not.toHaveBeenCalled()
    setHealthy(true)
    children[0]!.emitLine('dsh web: http://127.0.0.1:4577')
    const handle = await attempt
    expect(handle).toMatchObject({ origin: 'http://127.0.0.1:4577', ownership: 'spawned' })
    expect(calls).toEqual(['http://127.0.0.1:4577'])
  })

  it('surfaces child output and the inner loader-entry cause when the child exits before ready', async () => {
    const { probe } = controllableProbe()
    const children: FakeChild[] = []
    const sut = makeSupervisor({ probe, port: 3080, readyTimeoutMs: 1000, spawnChild: recordingSpawn(children) })
    const attempt = sut.ensure()
    const captured = attempt.catch((thrown: unknown) => thrown)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    children[0]!.emitLine('failed to apply loader entry include (cordis:include)')
    children[0]!.emitLine('failed to import loader entry @deepseek-ai/dsh-xyz: ERR_MODULE_NOT_FOUND')
    children[0]!.emitExit(1)
    const caught = await captured
    expect(caught).toBeInstanceOf(HostStartError)
    const startError = caught as HostStartError
    expect(startError.message).toContain('exited with 1')
    expect(startError.message).toContain('failed to import loader entry @deepseek-ai/dsh-xyz')
    expect(startError.output).toContain('cordis:include')
  })

  it('kills the child and fails when the ready budget expires', async () => {
    const { probe } = controllableProbe()
    const children: FakeChild[] = []
    const sut = makeSupervisor({ probe, port: 3080, readyTimeoutMs: 40, spawnChild: recordingSpawn(children) })
    const attempt = sut.ensure()
    const captured = attempt.catch((thrown: unknown) => thrown)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    const caught = await captured
    expect(caught).toBeInstanceOf(HostStartError)
    expect((caught as HostStartError).message).toMatch(/did not become ready within 40 ms/)
    expect(children[0]!.killed).toBe(true)
  })

  it('stop settles an in-flight start, kills the spawned child, and is idempotent', async () => {
    const { probe } = controllableProbe()
    const children: FakeChild[] = []
    const sut = makeSupervisor({ probe, port: 3080, readyTimeoutMs: 5000, spawnChild: recordingSpawn(children) })
    const attempt = sut.ensure()
    const captured = attempt.catch((thrown: unknown) => thrown)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    const stopping = sut.stop()
    const caught = await captured
    expect(caught).toBeInstanceOf(HostStartError)
    expect((caught as HostStartError).message).toMatch(/aborted by shutdown/)
    await stopping
    await sut.stop()
    expect(children[0]!.killed).toBe(true)
  })

  it('stop leaves an adopted host running', async () => {
    const { probe, setHealthy } = controllableProbe()
    setHealthy(true)
    const sut = makeSupervisor({
      probe,
      port: 3080,
      readyTimeoutMs: 1000,
      spawnChild: () => { throw new Error('must not spawn') },
    })
    await sut.ensure()
    await sut.stop()
    await expect(probe('http://127.0.0.1:3080')).resolves.toBeTruthy()
  })

  it('shares one start across concurrent ensure calls and reuses the handle', async () => {
    const { probe, setHealthy } = controllableProbe()
    const children: FakeChild[] = []
    const sut = makeSupervisor({ probe, port: 3080, readyTimeoutMs: 1000, spawnChild: recordingSpawn(children) })
    const first = sut.ensure()
    const second = sut.ensure()
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    setHealthy(true)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(await sut.ensure()).toBe(a)
  })

  it('respawns after a live handle stops probing healthy', async () => {
    const { probe, setHealthy } = controllableProbe()
    const children: FakeChild[] = []
    const sut = makeSupervisor({ probe, port: 3080, readyTimeoutMs: 1000, spawnChild: recordingSpawn(children) })
    setHealthy(true)
    const adopted = await sut.ensure()
    expect(adopted.ownership).toBe('adopted')
    setHealthy(false)
    const attempt = sut.ensure()
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    setHealthy(true)
    const spawned = await attempt
    expect(spawned.ownership).toBe('spawned')
  })
})

describe('preferSpawnCause', () => {
  it('prefers the inner loader-entry line over the include wrapper', () => {
    const output = 'failed to apply loader entry include (cordis:include)\nfailed to import loader entry x: boom'
    expect(preferSpawnCause(output)).toBe('failed to import loader entry x: boom')
  })

  it('falls back to the bounded tail when no inner cause exists', () => {
    expect(preferSpawnCause('plain output')).toBe('plain output')
    expect(preferSpawnCause(`${'x'.repeat(4096)}tail`)).toBe(`…${'x'.repeat(2044)}tail`)
  })
})
