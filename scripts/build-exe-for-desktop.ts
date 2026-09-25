/**
 * Build the dsh desktop executables: one deployed app closure plus the
 * official Electron runtime per target, assembled into a portable
 * application directory (renamed executable plus `resources/app` with a
 * symlink-free node_modules). No installer, signing, or rcedit metadata —
 * the portable directory is the artifact; a packaged installer is deferred.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/** The deploy root whose manifest supplies the packaged closure, peers included. */
const DEPLOY_ROOT_PACKAGE = '@deepseek-ai/dsh-desktop-runtime'
/** Legacy deploy may hoist workspace packages back into this source tree. */
const DEPLOY_SOURCE_NODE_MODULES = 'apps/desktop-runtime/node_modules'
/** The built desktop main, copied over the deploy (its npm payload is empty). */
const APP_SOURCE = 'apps/desktop'
const OUT_DIR = 'dist-desktop'
/** Download cache shared across targets and local reruns. */
const CACHE_DIR = join(OUT_DIR, '.cache')
/** Default release host; `ELECTRON_MIRROR` overrides it (@electron/get convention). */
const DEFAULT_ELECTRON_MIRROR = 'https://github.com/electron/electron/releases/download/'

const PLATFORMS = ['win32', 'linux', 'macos'] as const
const ARCHES = ['x64', 'arm64'] as const
type Platform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHES)[number]

/** Electron's release artifact names use `darwin`, not `macos`. */
function electronDistPlatform(platform: Platform): 'win32' | 'linux' | 'darwin' {
  return platform === 'macos' ? 'darwin' : platform
}

/** The packaged executable's file name per platform. */
function executableName(platform: Platform): string {
  return platform === 'win32' ? 'DSHDesktop.exe' : 'dsh-desktop'
}

function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value)
}

/** One packaging target, e.g. `win32-x64`. */
class Target {
  private constructor(
    readonly platform: Platform,
    readonly arch: Arch,
  ) {}

  get spec(): string {
    return `${this.platform}-${this.arch}`
  }

  /** Output directory holding the assembled application. */
  get outputDir(): string {
    return resolve(root, OUT_DIR, this.spec)
  }

  /**
   * Parse one target spec, rejecting malformed pairs and unsupported values.
   * @param spec - the raw pair, e.g. `win32-x64`.
   * @returns the parsed target.
   */
  static parse(spec: string): Target {
    const parts = spec.split('-')
    const [platform, arch] = parts
    if (parts.length !== 2 || platform === undefined || arch === undefined) {
      throw new Error(`build-exe-for-desktop: target ${JSON.stringify(spec)} must be <platform>-<arch>, e.g. win32-x64.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`build-exe-for-desktop: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`build-exe-for-desktop: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    return new Target(platform, arch)
  }

  /** Resolve the host-platform default. */
  static host(): Target {
    if (!isPlatform(process.platform)) {
      throw new Error(`build-exe-for-desktop: unsupported host platform ${process.platform}; pass --targets explicitly.`)
    }
    if (!isArch(process.arch)) {
      throw new Error(`build-exe-for-desktop: unsupported host arch ${process.arch}; pass --targets explicitly.`)
    }
    return new Target(process.platform, process.arch)
  }
}

/** Validated CLI configuration; construction owns help and parse-error exits. */
class BuildCli {
  private constructor(
    readonly targets: readonly Target[],
    readonly skipBuild: boolean,
    readonly dryRun: boolean,
  ) {}

  /**
   * Parse argv. Help exits 0; malformed flags exit 1.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @returns the parsed, validated configuration.
   */
  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      console.error(`build-exe-for-desktop: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(BuildCli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(BuildCli.usage())
      process.exit(0)
    }
    const targets = values.targets === undefined
      ? [Target.host()]
      : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(spec => Target.parse(spec))
    if (targets.length === 0) throw new Error('build-exe-for-desktop: --targets is empty.')
    const seen = new Set<string>()
    for (const target of targets) {
      const key = target.spec
      if (seen.has(key)) {
        throw new Error(`build-exe-for-desktop: duplicate target ${key} in --targets; output directory names would collide.`)
      }
      seen.add(key)
    }
    return new BuildCli(targets, values['skip-build'], values['dry-run'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return `Usage: tsx scripts/build-exe-for-desktop.ts [--targets=<platform>-<arch>,…]

Options:
  --targets     comma-separated targets: win32-x64, win32-arm64, linux-x64, linux-arm64,
                macos-x64, macos-arm64; default is the host platform
  --skip-build  skip the workspace build; lib/ artifacts must already exist
  --dry-run     print every command and filesystem change instead of executing
  -h, --help    show this help`
  }
}

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * The pnpm invocation for this host: the `pnpm` executable on POSIX, and the
 * `.cmd` shim wrapped through `cmd /D /S /C` on Windows (Node refuses to
 * spawn `.cmd` directly).
 * @param args - the pnpm arguments.
 * @returns the executable and its arguments.
 */
function pnpmCommand(args: readonly string[]): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: 'pnpm', args: [...args] }
  const command = ['pnpm', ...args].map(part => (part.includes(' ') ? `"${part}"` : part)).join(' ')
  return { file: 'cmd.exe', args: ['/D', '/S', '/C', `"${command}"`] }
}

/** True when the path exists, without throwing on missing parents. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Read one small text resource from the network. */
async function downloadText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`build-exe-for-desktop: downloading ${url} failed: HTTP ${response.status}`)
  return await response.text()
}

/**
 * Download one resource to a file while hashing it.
 * @param url - the resource URL.
 * @param destination - the target file path.
 * @returns the SHA-256 hex digest of the written bytes.
 */
async function downloadFileWithSha256(url: string, destination: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok || response.body === null) {
    throw new Error(`build-exe-for-desktop: downloading ${url} failed: HTTP ${response.status}`)
  }
  const hash = createHash('sha256')
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(response.body as NodeWebReadableStream),
    hashing,
    createWriteStream(destination),
  )
  return hash.digest('hex')
}

/**
 * The recorded SHA-256 for one artifact name, out of a `SHASUMS256.txt`
 * body. shasum emits two line shapes — `<hash>  <name>` (text) and
 * `<hash> *<name>` (binary) — so the entry is matched by line shape plus a
 * literal name suffix.
 * @param shasums - the release checksum file body.
 * @param name - the artifact file name.
 * @returns the 64-hex digest, or undefined when no entry exists.
 */
function recordedSha256(shasums: string, name: string): string | undefined {
  const entry = shasums.split('\n').map(line => line.trim())
    .find(line => line.endsWith(name) && /^[0-9a-f]{64} /.test(line))
  return entry?.slice(0, 64)
}

/** Sequential build pipeline. Subprocesses inherit stdio and errors include the command. */
class DesktopExeBuild {
  /** The cleared deploy target, copied into every packaging target. */
  readonly staging = resolve(root, OUT_DIR, 'staging')

  constructor(private readonly cli: BuildCli) {}

  /** Verify the closure before compiling or packaging. */
  async verifyClosure(): Promise<void> {
    const pnpm = pnpmCommand(['run', 'verify-runtime-closure'])
    await this.run('runtime dependency closure', pnpm.file, pnpm.args)
  }

  /** Build all package artifacts unless `--skip-build` was passed. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-for-desktop: skipping pnpm run build (--skip-build)')
      return
    }
    const pnpm = pnpmCommand(['run', 'build'])
    await this.run('build', pnpm.file, pnpm.args)
  }

  /**
   * Clear the staging directory and deploy the desktop app's production
   * closure into it: a symlink-free hoisted node_modules over the built
   * workspace packages.
   */
  async deployStaging(): Promise<void> {
    if (this.staging === root || root.startsWith(this.staging + sep)) {
      throw new Error(`build-exe-for-desktop: refusing to clear staging dir ${this.staging}: it contains the repo root.`)
    }
    if (this.cli.dryRun) {
      console.log(`build-exe-for-desktop: [dry-run] rm -rf ${this.staging}`)
      return
    }
    await rm(this.staging, { recursive: true, force: true })
    const pnpm = pnpmCommand([
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=true',
      '--config.link-workspace-packages=true',
      this.staging,
    ])
    await this.run('deploy', pnpm.file, pnpm.args)
    await this.restoreLegacyHoists()
    await this.materializeStagedLinks()
  }

  /**
   * Restore direct packages that pnpm's legacy hoister places beside the
   * deploy source instead of in the target, preserving one flat Cordis
   * instance and a symlink-free packaged payload.
   */
  private async restoreLegacyHoists(): Promise<void> {
    const manifest = JSON.parse(await readFile(join(this.staging, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const sourceNodeModules = resolve(root, DEPLOY_SOURCE_NODE_MODULES)
    const restored: string[] = []
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      const destination = join(this.staging, 'node_modules', dependency)
      if (await pathExists(destination)) continue
      const source = join(sourceNodeModules, dependency)
      if (!await pathExists(source)) {
        throw new Error(
          `build-exe-for-desktop: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
        )
      }
      await mkdir(dirname(destination), { recursive: true })
      const nestedNodeModules = join(source, 'node_modules')
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      restored.push(dependency)
    }
    if (restored.length > 0) {
      console.log(`build-exe-for-desktop: restored legacy deploy hoists: ${restored.join(', ')}`)
    }
  }

  /** Replace deploy-time package links with files, removing `.bin` links entirely. */
  private async materializeStagedLinks(): Promise<void> {
    const nodeModules = join(this.staging, 'node_modules')
    let link = await this.findSymlink(nodeModules)
    while (link !== undefined) {
      const segments = link.slice(nodeModules.length + 1).split(sep)
      const binIndex = segments.lastIndexOf('.bin')
      if (binIndex >= 0) {
        await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      } else {
        const target = await realpath(link)
        await rm(link, { recursive: true, force: true })
        await cp(target, link, { recursive: true, dereference: true })
        console.log(`build-exe-for-desktop: materialized staged link ${relative(this.staging, link)}`)
      }
      link = await this.findSymlink(nodeModules)
    }
  }

  /** Find one symlink under a directory, depth-first, or undefined. */
  private async findSymlink(path: string): Promise<string | undefined> {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(path, entry.name)
      const stats = await lstat(child)
      if (stats.isSymbolicLink()) return child
      if (entry.isDirectory()) {
        const nested = await this.findSymlink(child)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  /** Copy the built desktop main over the deploy (its npm payload is empty) and pin the payload facts. */
  async copyAppPayload(): Promise<void> {
    if (this.cli.dryRun) {
      console.log(`build-exe-for-desktop: [dry-run] cp -r ${resolve(root, APP_SOURCE, 'lib')} ${join(this.staging, 'lib')}`)
      return
    }
    await cp(resolve(root, APP_SOURCE, 'lib'), join(this.staging, 'lib'), { recursive: true })
    const main = join(this.staging, 'lib', 'types', 'main.js')
    const cliBin = join(this.staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    for (const [label, path] of [['desktop main', main], ['dsh CLI bin', cliBin]] as const) {
      if (!await pathExists(path)) {
        throw new Error(`build-exe-for-desktop: staged ${label} missing at ${relative(root, path)} — build and deploy must precede packaging.`)
      }
    }
    // The deploy root's manifest describes the closure, not the application;
    // the packaged app needs the desktop shell's identity and entry point.
    const appManifest = JSON.parse(await readFile(resolve(root, APP_SOURCE, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (typeof appManifest.name !== 'string' || typeof appManifest.version !== 'string') {
      throw new Error('build-exe-for-desktop: the desktop app manifest lacks name or version.')
    }
    await writeFile(join(this.staging, 'package.json'), `${JSON.stringify({
      name: appManifest.name,
      description: 'Packaged dsh desktop application directory.',
      version: appManifest.version,
      private: true,
      type: 'module',
      main: 'lib/types/main.js',
    }, null, 2)}\n`)
  }

  /**
   * Assemble one target: fetch and verify the Electron runtime, extract it,
   * and place the staged app at `resources/app` beside the renamed executable.
   * @param target - the packaging target.
   * @returns the assembled application directory.
   */
  async assemble(target: Target): Promise<string> {
    const version = await this.resolveElectronVersion()
    const electron = await this.fetchElectron(target, version)
    const outputDir = target.outputDir
    if (this.cli.dryRun) {
      console.log(`build-exe-for-desktop: [dry-run] assemble ${target.spec} from ${relative(root, electron)} into ${relative(root, outputDir)}`)
      return outputDir
    }
    await rm(outputDir, { recursive: true, force: true })
    await mkdir(outputDir, { recursive: true })
    await this.extract(electron, outputDir)
    // The runtime's shim app is dead weight once a real resources/app exists.
    await rm(join(outputDir, 'resources', 'default_app.asar'), { force: true })
    await mkdir(join(outputDir, 'resources'), { recursive: true })
    await cp(this.staging, join(outputDir, 'resources', 'app'), { recursive: true, dereference: true })
    const executable = join(outputDir, 'electron' + (target.platform === 'win32' ? '.exe' : ''))
    const packaged = join(outputDir, executableName(target.platform))
    await rename(executable, packaged)
    if (target.platform !== 'win32') await chmod(packaged, 0o755)
    return outputDir
  }

  /** The Electron version pinned by the desktop app's installed devDependency. */
  private async resolveElectronVersion(): Promise<string> {
    const manifestPath = resolve(root, APP_SOURCE, 'node_modules', 'electron', 'package.json')
    let manifest: { version?: unknown }
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
    } catch (error) {
      throw new Error(`build-exe-for-desktop: the desktop app's electron devDependency is not installed (${manifestPath}): ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error('build-exe-for-desktop: the installed electron package declares no version.')
    }
    return manifest.version
  }

  /**
   * Download (or reuse from cache) the Electron runtime zip after verifying
   * its SHA-256 against the release's `SHASUMS256.txt`.
   * @param target - the packaging target.
   * @param version - the pinned Electron version.
   * @returns the verified zip path.
   */
  private async fetchElectron(target: Target, version: string): Promise<string> {
    const name = `electron-v${version}-${electronDistPlatform(target.platform)}-${target.arch}.zip`
    const mirror = process.env.ELECTRON_MIRROR ?? DEFAULT_ELECTRON_MIRROR
    const base = mirror.endsWith('/') ? mirror : `${mirror}/`
    const cache = resolve(root, CACHE_DIR, name)
    if (await pathExists(cache)) {
      console.log(`build-exe-for-desktop: reusing cached ${relative(root, cache)}`)
      return cache
    }
    if (this.cli.dryRun) {
      console.log(`build-exe-for-desktop: [dry-run] fetch ${base}v${version}/${name}`)
      return cache
    }
    const shasums = await downloadText(`${base}v${version}/SHASUMS256.txt`)
    const expected = recordedSha256(shasums, name)
    if (expected === undefined) {
      throw new Error(`build-exe-for-desktop: SHASUMS256.txt carries no entry for ${name}.`)
    }
    await mkdir(dirname(cache), { recursive: true })
    const partial = await mkdtemp(join(tmpdir(), 'dsh-desktop-'))
    const download = join(partial, name)
    try {
      const actual = await downloadFileWithSha256(`${base}v${version}/${name}`, download)
      if (actual !== expected) {
        throw new Error(`build-exe-for-desktop: ${name} failed checksum verification: expected ${expected}, got ${actual}.`)
      }
      await rename(download, cache)
    } finally {
      await rm(partial, { recursive: true, force: true })
    }
    console.log(`build-exe-for-desktop: verified and cached ${relative(root, cache)}`)
    return cache
  }

  /** Extract one zip into a directory; PowerShell on Windows, `unzip` elsewhere. */
  private async extract(zip: string, destination: string): Promise<void> {
    if (process.platform === 'win32') {
      await this.run('extract', 'powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(zip)} -DestinationPath ${JSON.stringify(destination)} -Force`,
      ])
      return
    }
    await this.run('extract', 'unzip', ['-q', zip, '-d', destination])
  }

  /**
   * Run one subprocess with inherited stdio. Spawn and non-zero-exit errors
   * include the command; dry runs only print it.
   * @param label - the step name used in logs and error messages.
   * @param command - the executable.
   * @param args - its arguments.
   */
  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-desktop: [dry-run] ${printable}`)
      return
    }
    console.log(`build-exe-for-desktop: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: 'inherit',
        // Artifact builds must not mutate or validate a developer's Git hooks.
        env: { ...process.env, CI: 'true' },
      })
      child.once('error', (error) => {
        reject(new Error(`build-exe-for-desktop: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`build-exe-for-desktop: ${label} failed (${cause}): ${printable}`))
      })
    })
  }
}

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new DesktopExeBuild(cli)
  console.log(`build-exe-for-desktop: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.copyAppPayload()
  const products: string[] = []
  for (const target of cli.targets) products.push(await pipeline.assemble(target))
  if (!cli.dryRun) {
    for (const product of products) console.log(`build-exe-for-desktop: product: ${product}`)
  }
}

await main()
