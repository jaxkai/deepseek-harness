/**
 * Launch resolution for the supervised `dsh --profile web` host. The desktop
 * shell never interprets a shell string: every launch is an executable plus
 * an argv array, and the Windows arms refuse the extensionless POSIX shim an
 * npm install leaves beside `dsh.cmd` (CreateProcess cannot execute it).
 * @module @deepseek-ai/dsh-desktop/launch
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** One shell-free executable invocation for the host child. */
export interface HostLaunch {
  /** Executable file; never a shell command string. */
  readonly file: string
  /** argv after the executable. */
  readonly args: readonly string[]
  /** Child working directory; omitted inherits the supervisor process's. */
  readonly cwd?: string
  /** Extra child environment layered over the supervisor process's. */
  readonly env?: Readonly<Record<string, string>>
}

/** Resolver inputs, injectable so tests pin every platform arm without spawning. */
export interface LaunchInput {
  /** `process.platform` of the supervisor. */
  readonly platform: string
  /** Node or Electron executable hosting the supervisor process. */
  readonly execPath: string
  /** True inside Electron (`process.versions.electron` is set). */
  readonly electron: boolean
  /** Explicit `DSH_DESKTOP_BIN` override, when the environment names one. */
  readonly binOverride?: string
  /** Bind host the web profile is told to use. */
  readonly host: string
  /** Bind port; 0 asks the OS for a private free port. */
  readonly port: number
}

/** The `--profile web` argument tail every launch shape shares. */
function webArgs(host: string, port: number): readonly string[] {
  return ['--profile', 'web', '--host', host, '--port', String(port)]
}

/**
 * Resolve the host launch. An explicit `DSH_DESKTOP_BIN` override wins and is
 * shaped per platform; otherwise the launch is this workspace's
 * `@deepseek-ai/dsh` CLI under the current executable. Under Electron that
 * executable is the app binary, and `ELECTRON_RUN_AS_NODE` restores
 * plain-Node semantics for the child.
 * @param input - platform and process facts plus the bind endpoint.
 * @returns the executable invocation for the host child.
 */
export function resolveHostLaunch(input: LaunchInput): HostLaunch {
  const { host, port } = input
  if (input.binOverride !== undefined) {
    const bin = input.binOverride
    if (input.platform === 'win32') {
      const lower = bin.toLowerCase()
      if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
        // Node refuses to spawn .cmd/.bat directly (the 2024 shell-injection
        // fix); cmd /D /S /C with one quoted command string is the supported
        // no-shell equivalent.
        return {
          file: 'cmd.exe',
          args: ['/D', '/S', '/C', `"${bin}" ${webArgs(host, port).join(' ')}`],
        }
      }
      if (lower.endsWith('.exe')) return { file: bin, args: webArgs(host, port) }
      throw new Error(
        `dsh-desktop: DSH_DESKTOP_BIN ${JSON.stringify(bin)} is the extensionless POSIX shim, which Windows cannot execute;`
        + ' point it at dsh.cmd, dsh.exe, or a node.exe + lib/bin.js pair',
      )
    }
    return { file: bin, args: webArgs(host, port) }
  }
  const require = createRequire(import.meta.url)
  const cliRoot = dirname(require.resolve('@deepseek-ai/dsh/package.json'))
  return {
    file: input.execPath,
    args: [join(cliRoot, 'lib', 'bin.js'), ...webArgs(host, port)],
    ...input.electron && { env: { ELECTRON_RUN_AS_NODE: '1' } },
  }
}
