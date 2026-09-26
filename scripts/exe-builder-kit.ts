/**
 * Shared machinery for the exe-builder scripts
 * (`build-exe-for-python-sdk.ts`, `build-exe-for-desktop.ts`): the shared
 * flag family, target-list parsing, closed-vocabulary guards, command
 * rendering, and the labeled subprocess runner. One home keeps the
 * builders symmetric without cross-file clones.
 * @module ./exe-builder-kit
 */

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

/** The flag family every exe builder parses identically. */
export interface ExeBuilderFlags {
  /** `--targets`, a comma-separated target-spec list; absent means the host default. */
  targets?: string
  /** `--skip-build`: lib/ artifacts must already exist. */
  'skip-build': boolean
  /** `--dry-run`: print commands and filesystem changes instead of executing. */
  'dry-run': boolean
  /** `--help`: print usage and exit 0. */
  help: boolean
}

/**
 * Parse the shared exe-builder flag family.
 * @param argv - the raw arguments (`process.argv.slice(2)`).
 * @returns the parsed flag values.
 */
export function parseExeBuilderFlags(argv: string[]): ExeBuilderFlags {
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

/**
 * Parse argv up to the help exit. A parse error prints the builder's label
 * and usage and exits 1; `--help` prints usage and exits 0.
 * @param argv - the raw arguments (`process.argv.slice(2)`).
 * @param label - the builder's error label, e.g. `build-exe-for-desktop`.
 * @param usage - the builder's usage text.
 * @returns the parsed flag values.
 */
export function parseExeBuilderCli(argv: string[], label: string, usage: string): ExeBuilderFlags {
  let flags: ExeBuilderFlags
  try {
    flags = parseExeBuilderFlags(argv)
  } catch (error) {
    console.error(`${label}: ${error instanceof Error ? error.message : String(error)}\n`)
    console.error(usage)
    process.exit(1)
  }
  if (flags.help) {
    console.log(usage)
    process.exit(0)
  }
  return flags
}

/**
 * Parse the `--targets` list: the host default when absent, one parsed
 * target per comma-separated spec, and no duplicate output-colliding keys.
 * @param raw - the raw `--targets` value.
 * @param options - the host default, the spec parser, and the duplicate
 *   error message, all named by the owning builder.
 * @returns the parsed target list.
 */
export function parseExeTargetList<T>(
  raw: string | undefined,
  options: {
    /** The host-default target. */
    host: () => T
    /** One target-spec parser. */
    parse: (spec: string) => T
    /** The output-collision key for duplicate detection. */
    key: (target: T) => string
    /** The builder's error label. */
    label: string
    /** The duplicate-key error message for the builder's collision domain. */
    duplicate: (key: string) => string
  },
): T[] {
  const targets = raw === undefined
    ? [options.host()]
    : raw.split(',').map(part => part.trim()).filter(part => part !== '').map(options.parse)
  if (targets.length === 0) throw new Error(`${options.label}: --targets is empty.`)
  const seen = new Set<string>()
  for (const target of targets) {
    const key = options.key(target)
    if (seen.has(key)) throw new Error(`${options.label}: ${options.duplicate(key)}`)
    seen.add(key)
  }
  return targets
}

/** Validated CLI configuration for one exe builder. */
export class ExeBuilderCli<T> {
  private constructor(
    /** Build targets; the host default when `--targets` is absent. */
    readonly targets: readonly T[],
    /** Skip the workspace build; lib/ artifacts must already exist. */
    readonly skipBuild: boolean,
    /** Print commands and filesystem changes instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /**
   * Parse argv. Help exits 0; malformed flags exit 1; invalid or colliding
   * targets throw.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @param options - the builder's label, usage text, and target-list hooks.
   * @returns the parsed, validated configuration.
   */
  static parse<T>(argv: string[], options: {
    /** The builder's error label. */
    label: string
    /** The builder's usage text. */
    usage: string
    /** The host-default target. */
    host: () => T
    /** One target-spec parser. */
    parse: (spec: string) => T
    /** The output-collision key for duplicate detection. */
    key: (target: T) => string
    /** The duplicate-key error message for the builder's collision domain. */
    duplicate: (key: string) => string
  }): ExeBuilderCli<T> {
    const values = parseExeBuilderCli(argv, options.label, options.usage)
    const targets = parseExeTargetList(values.targets, options)
    return new ExeBuilderCli(targets, values['skip-build'], values['dry-run'])
  }
}

/**
 * A string guard over one closed target vocabulary.
 * @param allowed - the closed vocabulary.
 * @returns the type guard for that vocabulary.
 */
export function enumGuard<T extends string>(allowed: readonly T[]): (value: string) => value is T {
  return (value): value is T => (allowed as readonly string[]).includes(value)
}

/**
 * Validate one closed vocabulary member of a target spec.
 * @param value - the raw spec part.
 * @param allowed - the closed vocabulary.
 * @param kind - the part's name for the error message, e.g. `platform`.
 * @param label - the builder's error label.
 * @param spec - the whole spec the part came from, for the error message.
 * @returns the validated member.
 */
export function requireTargetPart<T extends string>(
  value: string,
  allowed: readonly T[],
  kind: string,
  label: string,
  spec: string,
): T {
  const guard = enumGuard(allowed)
  if (!guard(value)) {
    throw new Error(`${label}: target ${JSON.stringify(spec)}: ${kind} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}.`)
  }
  return value
}

/**
 * Split one target spec into its dash-separated parts, checking the
 * documented shape.
 * @param spec - the raw target spec, e.g. `win32-x64`.
 * @param label - the builder's error label.
 * @param shape - the documented shape, e.g. `<platform>-<arch>`; its dash
 *   count fixes the required part count.
 * @param example - one valid spec for the error message.
 * @returns the spec's parts.
 */
export function parseTargetSpecParts(spec: string, label: string, shape: '<platform>-<arch>', example: string): [string, string]
export function parseTargetSpecParts(spec: string, label: string, shape: '<nodeRange>-<platform>-<arch>', example: string): [string, string, string]
export function parseTargetSpecParts(spec: string, label: string, shape: string, example: string): string[] {
  const parts = spec.split('-')
  if (parts.length - 1 !== countDashes(shape) || parts.some(part => part === '')) {
    throw new Error(`${label}: target ${JSON.stringify(spec)} must be ${shape}, e.g. ${example}.`)
  }
  return parts
}

/** The dash count of a documented target shape. */
function countDashes(shape: string): number {
  let dashes = 0
  for (const character of shape) if (character === '-') dashes += 1
  return dashes
}

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
export function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Run one subprocess step with inherited stdio; a dry run only prints it.
 * A spawn error or a non-zero exit rejects with the step and command.
 * @param options - the step's names, command, and run mode.
 */
export async function runExeStep(options: {
  /** The builder's log prefix, e.g. `build-exe-for-desktop`. */
  prefix: string
  /** The step name used in logs and error messages. */
  step: string
  /** The executable. */
  command: string
  /** Its arguments. */
  args: readonly string[]
  /** True to print the command instead of executing it. */
  dryRun: boolean
  /** The working directory; defaults to the process's. */
  cwd?: string
  /** Extra environment layered over the process's. */
  env?: Readonly<Record<string, string>>
}): Promise<void> {
  const printable = formatCommand(options.command, options.args)
  const { prefix, step } = options
  if (options.dryRun) {
    console.log(`${prefix}: [dry-run] ${printable}`)
    return
  }
  console.log(`${prefix}: ${step}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(options.command, [...options.args], {
      ...options.cwd !== undefined && { cwd: options.cwd },
      stdio: 'inherit',
      // Artifact builds must not mutate or validate a developer's Git hooks.
      env: { ...process.env, CI: 'true', ...options.env },
    })
    child.once('error', (error) => {
      reject(new Error(`${prefix}: ${step} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`${prefix}: ${step} failed (${cause}): ${printable}`))
    })
  })
}
