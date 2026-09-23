// 六壳安装检测：装没装上、装的哪版、最新是哪版、能不能更新。
import { execFile as execFileCallback } from 'node:child_process'
import { access, lstat, open, readFile, readdir, realpath as realpathFs } from 'node:fs/promises'
import { delimiter, join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { compareVersions, npmRegistries, shellIds, type Recipes, type ShellId } from '../recipes/recipes'

const execFile = promisify(execFileCallback)

export interface ShellInventoryEntry {
  readonly id: ShellId
  readonly label: string
  /** null = 这个系统上无法判断。 */
  readonly installed: boolean | null
  readonly version: string
  /** 找到了程序但版本没读出来。⛔ 与「没装」混为一谈:兼容闸门要据此按不通过处理。 */
  readonly versionUnknown: boolean
  readonly latest: string
  readonly updatable: boolean
  readonly method: 'npm' | 'script' | 'app' | 'none'
  readonly location: string
  readonly officialPage: string
  /** Claude Code only: the Claude desktop app is present. It signs in to a Claude account and cannot use model API Keys. */
  readonly claudeDesktop?: boolean
}

/** Which Claude editions are on this computer, from file presence only: nothing is executed or fetched. */
export interface ClaudeEditions {
  readonly cli: boolean
  readonly desktop: boolean
}

export interface ShellInventoryDeps {
  readonly platform: string
  readonly home: string
  readonly env: NodeJS.ProcessEnv
  readonly recipes: () => Recipes
  readonly exec?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv, options?: { windowsVerbatimArguments?: true }) => Promise<string>
  readonly exists?: (path: string) => Promise<boolean>
  /** Hermes candidates must have the documented fixed virtualenv shape before execution. */
  readonly realpath?: (path: string) => Promise<string>
  /** Test seam only; production uses the bounded shared Hermes launcher validator below. */
  readonly validateHermesExecutable?: (candidate: string, platform: string) => Promise<boolean>
  /** Test seam only; production reads a version only from a fixed trusted candidate. */
  readonly trustedVersion?: (shell: TrustedCliShell, platform: string, home: string, env: NodeJS.ProcessEnv) => Promise<TrustedCliVersion | undefined>
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

const LATEST_CACHE_MS = 6 * 60 * 60_000
const MAX_HERMES_CONSOLE_SCRIPT_BYTES = 8 * 1024
/**
 * This is an execution trust anchor, not a configurable Windows installation discovery path.
 * A nonstandard Windows root fails closed: callers cannot turn an inherited environment value
 * into an executable directory.
 */
export const trustedWindowsSystemRoot = 'C:\\Windows'
const defaultExec = async (command: string, args: readonly string[], env: NodeJS.ProcessEnv, options?: { windowsVerbatimArguments?: true }): Promise<string> =>
  (await execFile(command, [...args], { encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024, env, windowsHide: true, ...options })).stdout
const defaultExists = async (path: string): Promise<boolean> => { try { await access(path); return true } catch { return false } }

export function extraBinDirectories(platform: string, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming'), local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [join(appData, 'npm'), join(local, 'Programs', 'Claude'), join(home, '.local', 'bin'), join(local, 'pnpm')]
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.hermes', 'bin'), join(home, '.local', 'share', 'pnpm')]
}

function platformPath(platform: string): typeof posix { return platform === 'win32' ? win32 : posix }

/** Default Hermes home when the customer has not supplied an absolute HERMES_HOME. */
export function trustedHermesInstallationRoot(platform: string, home: string, env: NodeJS.ProcessEnv): string {
  const path = platformPath(platform)
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA !== undefined && path.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA : path.join(home, 'AppData', 'Local')
    return path.join(local, 'hermes')
  }
  return path.join(home, '.hermes')
}

/**
 * Hermes' generated Unix launcher invokes a few utility programs before its fixed virtualenv
 * Python. Keep those lookups on the operating-system path and deliberately omit PYTHON* and
 * arbitrary customer PATH entries. This is shared by inventory, configuration, and acceptance.
 */
export function trustedHermesEnvironment(platform: string, hermesHome: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HERMES_HOME: hermesHome }
  if (platform === 'win32') {
    const systemRoot = trustedWindowsSystemRoot
    env.PATH = [win32.join(systemRoot, 'System32'), systemRoot].join(';')
    env.SystemRoot = systemRoot
    for (const key of ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG'] as const) {
      if (source[key] !== undefined) env[key] = source[key]
    }
    return env
  }
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM'] as const) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  return env
}

/** An absolute HERMES_HOME selects both Hermes' configuration and its fixed virtualenv candidate. */
function configuredHermesRoot(platform: string, home: string, env: NodeJS.ProcessEnv): string {
  const path = platformPath(platform)
  if (env.HERMES_HOME !== undefined && path.isAbsolute(env.HERMES_HOME)) return env.HERMES_HOME
  return trustedHermesInstallationRoot(platform, home, env)
}

/**
 * The only Hermes command paths we trust enough to execute. Generic PATH hits are shown as
 * installed-but-version-unknown, but must never receive even a harmless-looking `--version`.
 */
export function trustedHermesCommandCandidates(platform: string, root: string): readonly string[] {
  const path = platformPath(platform)
  const executable = platform === 'win32' ? 'hermes.exe' : 'hermes'
  const venvDirectory = platform === 'win32' ? 'Scripts' : 'bin'
  return [path.join(root, 'hermes-agent', 'venv', venvDirectory, executable)]
}

/**
 * Hermes' documented virtualenv entry is a generated Python console-script shim, not a general
 * shell launcher. Keep this deliberately narrow: a future unexpected launcher blocks safely
 * instead of executing arbitrary shell content from a customer's home directory.
 */
const hermesConsoleScript = [
  '#!/bin/sh',
  `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python3' "$0" "$@"`,
  "' '''",
  '# -*- coding: utf-8 -*-',
  'import sys',
  'from hermes_cli.main import main',
  'if __name__ == "__main__":',
  '    if sys.argv[0].endswith("-script.pyw"):',
  '        sys.argv[0] = sys.argv[0][:-11]',
  '    elif sys.argv[0].endswith(".exe"):',
  '        sys.argv[0] = sys.argv[0][:-4]',
  '    sys.exit(main())'
].join('\n')

function isHermesConsoleScript(contents: string): boolean {
  const normalized = contents.replace(/\r\n?/g, '\n')
  return normalized === hermesConsoleScript || normalized === `${hermesConsoleScript}\n`
}

/**
 * The one non-native Hermes exception. Trust comes from the candidate's fixed virtualenv layout,
 * exact documented console-script, and ordinary non-symlink file shape. It intentionally does
 * not depend on `$HOME/.hermes`: Hermes supports a relocated `HERMES_HOME`.
 */
export function trustedHermesExecutable(candidate: string, platform: string): Promise<boolean>
/** @deprecated The former root argument is ignored; use `(candidate, platform)`. */
export function trustedHermesExecutable(candidate: string, _root: string, platform: string): Promise<boolean>
export async function trustedHermesExecutable(candidate: string, platformOrRoot: string, legacyPlatform?: string): Promise<boolean> {
  const platform = legacyPlatform ?? platformOrRoot
  const path = platformPath(platform)
  const executable = platform === 'win32' ? 'hermes.exe' : 'hermes'
  const venvDirectory = platform === 'win32' ? 'Scripts' : 'bin'
  if (!path.isAbsolute(candidate)) return false
  const normalized = path.resolve(candidate)
  const scriptDirectory = path.dirname(normalized)
  const venvDirectoryPath = path.dirname(scriptDirectory)
  const agentDirectory = path.dirname(venvDirectoryPath)
  if (path.basename(normalized) !== executable || path.basename(scriptDirectory) !== venvDirectory ||
    path.basename(venvDirectoryPath) !== 'venv' || path.basename(agentDirectory) !== 'hermes-agent') return false
  try {
    const details = await lstat(candidate)
    if (!details.isFile() || details.isSymbolicLink()) return false
    const resolvedCandidate = await realpathFs(candidate)
    if (!samePath(candidate, resolvedCandidate, platform)) return false
    if (platform === 'win32') return nativeExecutable(candidate)
    if (details.size > MAX_HERMES_CONSOLE_SCRIPT_BYTES) return false
    return isHermesConsoleScript(await readFile(candidate, 'utf8'))
  } catch { return false }
}

/**
 * Acceptance runners may execute only an exact command inside a documented upstream installation
 * location that this product treats as a policy trust anchor. This deliberately does not inspect PATH: a PATH hit can be a customer
 * wrapper and even `--version` has side effects for some wrappers.
 */
export type TrustedCliShell = Extract<ShellId, 'codex' | 'claude-code' | 'hermes'>

function codexNativeVendorCandidates(path: typeof posix, root: string, platform: string): readonly string[] {
  const executable = platform === 'win32' ? 'codex.exe' : 'codex'
  const targets: readonly { target: string; packageName: string }[] = platform === 'darwin'
    ? [{ target: 'aarch64-apple-darwin', packageName: 'codex-darwin-arm64' }, { target: 'x86_64-apple-darwin', packageName: 'codex-darwin-x64' }]
    : platform === 'win32'
      ? [{ target: 'aarch64-pc-windows-msvc', packageName: 'codex-win32-arm64' }, { target: 'x86_64-pc-windows-msvc', packageName: 'codex-win32-x64' }]
      : [{ target: 'aarch64-unknown-linux-musl', packageName: 'codex-linux-arm64' }, { target: 'x86_64-unknown-linux-musl', packageName: 'codex-linux-x64' }]
  return targets.flatMap(({ target, packageName }) => ['bin', 'codex'].flatMap(directory => [
    // Older package layout.
    path.join(root, '@openai', 'codex', 'vendor', target, directory, executable),
    // Current official npm layout: the launcher remains a JS shim, but this nested vendor file is native.
    path.join(root, '@openai', 'codex', 'node_modules', '@openai', packageName, 'vendor', target, directory, executable)
  ]))
}

async function trustedCodexCommandCandidates(platform: string, home: string, env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const path = platformPath(platform)
  const candidates: string[] = []
  if (platform === 'darwin') {
    candidates.push(...['/Applications', path.join(home, 'Applications')].flatMap(root =>
      ['Codex.app', 'ChatGPT.app'].map(app => path.join(root, app, 'Contents', 'Resources', 'codex'))))
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA !== undefined && path.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA : path.join(home, 'AppData', 'Local')
    candidates.push(
      path.join(local, 'Programs', 'Codex', 'resources', 'codex.exe'),
      path.join(local, 'Programs', 'ChatGPT', 'resources', 'codex.exe'),
      path.join(local, 'ChatGPT', 'resources', 'codex.exe')
    )
  }
  // `npm install -g @openai/codex` installs a JS shim in PATH and a native vendor binary below
  // the global package root. Never execute the shim; enumerate only fixed standard global roots.
  const globalRoots = platform === 'win32'
    ? [path.join(env.APPDATA !== undefined && path.isAbsolute(env.APPDATA) ? env.APPDATA : path.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules')]
    : [path.join(home, '.npm-global', 'lib', 'node_modules'), path.join(home, '.local', 'lib', 'node_modules'), '/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules']
  const nvmRoot = platform === 'win32' ? undefined : path.join(home, '.nvm', 'versions', 'node')
  const nvmVersions = nvmRoot === undefined ? [] : (await readdir(nvmRoot).catch(() => []))
    .filter(name => /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(name))
    .map(name => path.join(nvmRoot, name, 'lib', 'node_modules'))
  for (const root of [...globalRoots, ...nvmVersions]) candidates.push(...codexNativeVendorCandidates(path, root, platform))
  return candidates
}

/**
 * Known Claude Code releases are native files directly below this official installer directory.
 * Reading that directory is safe; it neither resolves nor executes the PATH launcher.
 */
async function trustedClaudeCommandCandidates(platform: string, home: string, env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const path = platformPath(platform)
  const userHome = platform === 'win32' && env.USERPROFILE !== undefined && path.isAbsolute(env.USERPROFILE) ? env.USERPROFILE : home
  // Claude Code's native installer documents this fixed location on macOS/Linux and Windows.
  // Keep the version cache too: both are official locations, neither involves PATH discovery.
  const nativeInstaller = path.join(userHome, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude')
  const root = path.join(home, '.local', 'share', 'claude', 'versions')
  const names = await readdir(root).catch(() => [])
  return [nativeInstaller, ...names
    .filter(name => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\.exe)?$/.test(name))
    .map(name => path.join(root, name))]
}

/**
 * No-PATH candidate inventory used by real-Key acceptance and the matrix worker. A caller still
 * verifies that the selected candidate is a non-symlink native binary before executing it.
 */
export async function trustedCliCommandCandidates(shell: TrustedCliShell, platform: string, home: string, env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  if (shell === 'hermes') return trustedHermesCommandCandidates(platform, configuredHermesRoot(platform, home, env))
  if (shell === 'codex') return trustedCodexCommandCandidates(platform, home, env)
  return trustedClaudeCommandCandidates(platform, home, env)
}

/**
 * Return a command only after it has been tied to an official fixed installation location.
 * This is deliberately stricter than the non-executing presence check below: login and version
 * checks must never turn a PATH wrapper (or a symlink to one) into executable code.
 */
export async function trustedCliExecutable(shell: TrustedCliShell, platform: string, home: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return (await trustedCliExecutables(shell, platform, home, env))[0]
}

/**
 * Every candidate that passes the fixed-location trust checks, in probe order. Readers that can
 * fail per-binary (an app-bundled codex whose quota endpoint cannot connect on some machines)
 * walk this list instead of dying with the first accepted binary.
 */
export async function trustedCliExecutables(shell: TrustedCliShell, platform: string, home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const path = platformPath(platform)
  const candidates = await trustedCliCommandCandidates(shell, platform, home, env)
  const accepted: string[] = []
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink()) continue
    const resolved = await realpathFs(candidate).catch(() => undefined)
    if (resolved === undefined) continue
    if (shell === 'hermes') {
      if (!await trustedHermesExecutable(candidate, platform)) continue
    } else if (path.resolve(resolved) !== path.resolve(candidate) || !await nativeExecutable(candidate)) continue
    accepted.push(candidate)
  }
  return accepted
}

export interface TrustedCliVersion {
  readonly executable: string
  readonly version: string
  readonly versionUnknown: boolean
}

/** Read a version only from a fixed trusted executable. It never searches or invokes PATH. */
export async function trustedCliVersion(shell: TrustedCliShell, platform: string, home: string, env: NodeJS.ProcessEnv): Promise<TrustedCliVersion | undefined> {
  const executable = await trustedCliExecutable(shell, platform, home, env)
  if (executable === undefined) return undefined
  try {
    const hermesRoot = shell === 'hermes' ? configuredHermesRoot(platform, home, env) : undefined
    const { stdout } = await execFile(executable, ['--version'], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024,
      env: hermesRoot === undefined ? env : trustedHermesEnvironment(platform, hermesRoot, env), windowsHide: true
    })
    const version = parseVersion(String(stdout))
    return { executable, version, versionUnknown: !version }
  } catch {
    return { executable, version: '', versionUnknown: true }
  }
}

/** A real-Key workflow may show a trusted CLI as present, but never runs it for version detection. */
export async function trustedCliInstalled(shell: TrustedCliShell, platform: string, home: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const candidate of await trustedCliCommandCandidates(shell, platform, home, env)) {
    const info = await lstat(candidate).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink()) continue
    if (shell === 'hermes' && !await trustedHermesExecutable(candidate, platform)) continue
    return true
  }
  return false
}

function samePath(first: string, second: string, platform: string): boolean {
  const path = platformPath(platform)
  return path.resolve(first) === path.resolve(second)
}

async function nativeExecutable(candidate: string): Promise<boolean> {
  try {
    const handle = await open(candidate, 'r')
    try {
      const header = Buffer.alloc(4)
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      if (bytesRead >= 2 && header[0] === 0x4d && header[1] === 0x5a) return true // PE
      if (bytesRead < 4) return false
      const value = header.readUInt32BE(0)
      return value === 0x7f454c46 || // ELF
        value === 0xfeedface || value === 0xfeedfacf || // Mach-O big endian
        value === 0xcefaedfe || value === 0xcffaedfe || // Mach-O little endian
        value === 0xcafebabe || value === 0xbebafeca || // Universal/fat Mach-O big/little endian
        value === 0xcafebabf || value === 0xbfbafeca
    } finally { await handle.close() }
  } catch { return false }
}

export function augmentedEnvironment(platform: string, home: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const current = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const path = [...new Set([...current, ...extraBinDirectories(platform, home, env)])].join(delimiter)
  return { ...env, PATH: path, ...(platform === 'win32' ? { Path: path } : {}) }
}

function commandNames(platform: string, command: string): readonly string[] {
  return platform === 'win32' ? [`${command}.cmd`, `${command}.exe`, `${command}.ps1`, command] : [command]
}

export function commandSearchDirectories(platform: string, home: string, env: NodeJS.ProcessEnv): readonly string[] {
  const environment = augmentedEnvironment(platform, home, env)
  return (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(Boolean)
}

/**
 * One discovery source for inventory and callers that must execute the same installed CLI.
 * It deliberately returns the file path only; callers still decide their own execution policy.
 */
export function commandCandidates(command: string, platform: string, home: string, env: NodeJS.ProcessEnv): readonly string[] {
  const names = commandNames(platform, command)
  return commandSearchDirectories(platform, home, env).flatMap(directory => names.map(name => join(directory, name)))
}

export async function findCommandPath(command: string, platform: string, home: string, env: NodeJS.ProcessEnv,
  exists: (path: string) => Promise<boolean> = defaultExists): Promise<string | undefined> {
  for (const candidate of commandCandidates(command, platform, home, env)) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

export function parseVersion(output: string): string {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)
  return match ? match[1] : ''
}

export class ShellInventory {
  private latestCache = new Map<string, { version: string; at: number }>()
  private readonly exec: NonNullable<ShellInventoryDeps['exec']>
  private readonly exists: NonNullable<ShellInventoryDeps['exists']>
  private readonly validateHermesExecutable: NonNullable<ShellInventoryDeps['validateHermesExecutable']>
  private readonly trustedVersion: NonNullable<ShellInventoryDeps['trustedVersion']>
  constructor(private readonly deps: ShellInventoryDeps) {
    this.exec = deps.exec ?? defaultExec
    this.exists = deps.exists ?? defaultExists
    this.validateHermesExecutable = deps.validateHermesExecutable ?? trustedHermesExecutable
    this.trustedVersion = deps.trustedVersion ?? trustedCliVersion
  }

  environment(): NodeJS.ProcessEnv { return augmentedEnvironment(this.deps.platform, this.deps.home, this.deps.env) }

  async list(): Promise<ShellInventoryEntry[]> { return Promise.all(shellIds.map((id) => this.inspect(id))) }

  async inspect(id: ShellId): Promise<ShellInventoryEntry> {
    const recipe = this.deps.recipes().shells[id]
    const base = { id, label: recipe.label, officialPage: recipe.officialPage }
    const installCommand = recipe.install?.darwin ?? recipe.install?.win32
    const method: ShellInventoryEntry['method'] = installCommand ? (installCommand[0] === 'npm' ? 'npm' : 'script') : recipe.macApps ? 'app' : 'none'
    let installed: boolean | null = false, version = '', location = '', versionUnknown = false
    if (recipe.command) {
      const found = id === 'hermes' ? await this.probeHermesCommand(recipe.command)
        : id === 'codex' || id === 'claude-code' ? await this.probeTrustedCommand(id, recipe.command)
          : await this.probePassiveCommand(recipe.command)
      if (found) { installed = true; version = found.version; location = found.location; versionUnknown = found.versionUnknown }
    }
    if (!installed && recipe.macApps && this.deps.platform === 'darwin') {
      const found = await this.probeMacApp(recipe.macApps)
      if (found) { installed = true; version = found.version; location = found.location; versionUnknown = found.versionUnknown }
    }
    if (!installed && !recipe.command && !(recipe.macApps && this.deps.platform === 'darwin')) installed = null
    const latest = await this.latest(id)
    const updatable = installed === true && !!version && !!latest && compareVersions(latest, version) > 0
    const desktop = id === 'claude-code' ? { claudeDesktop: await this.claudeDesktopPresent() } : {}
    return { ...base, installed, version, versionUnknown, latest, updatable, method, location, ...desktop }
  }

  /**
   * Customers reach the official download page and often install the Claude desktop app instead
   * of the Claude Code CLI. Only the CLI reads the Toolbox model API configuration, so the model
   * API page needs to tell the two apart without running either program.
   */
  async claudeEditions(): Promise<ClaudeEditions> {
    const [cli, desktop] = await Promise.all([this.claudeCliPresent(), this.claudeDesktopPresent()])
    return { cli, desktop }
  }

  private async claudeCliPresent(): Promise<boolean> {
    for (const candidate of await trustedCliCommandCandidates('claude-code', this.deps.platform, this.deps.home, this.deps.env)) {
      if (await this.exists(candidate)) return true
    }
    return await this.claudePathHit() !== undefined
  }

  /**
   * A Store-packaged Claude desktop can register an app execution alias named Claude.exe in
   * `%LOCALAPPDATA%\Microsoft\WindowsApps`, which is on PATH. That alias launches the desktop app,
   * not Claude Code, so it must never count as the CLI.
   */
  private async claudePathHit(): Promise<string | undefined> {
    for (const candidate of commandCandidates('claude', this.deps.platform, this.deps.home, this.deps.env)) {
      // Per-user and machine alias folders are both named Microsoft\WindowsApps; only aliases live there.
      if (this.deps.platform === 'win32' && /[\\/]microsoft[\\/]windowsapps[\\/][^\\/]+$/i.test(candidate)) continue
      if (await this.exists(candidate)) return candidate
    }
    return undefined
  }

  private async claudeDesktopPresent(): Promise<boolean> {
    const path = platformPath(this.deps.platform)
    if (this.deps.platform === 'darwin') {
      for (const root of ['/Applications', path.join(this.deps.home, 'Applications')]) {
        if (await this.exists(path.join(root, 'Claude.app', 'Contents', 'Info.plist'))) return true
      }
      return false
    }
    if (this.deps.platform === 'win32') {
      const local = this.deps.env.LOCALAPPDATA !== undefined && path.isAbsolute(this.deps.env.LOCALAPPDATA)
        ? this.deps.env.LOCALAPPDATA : path.join(this.deps.home, 'AppData', 'Local')
      // The Store/MSIX package registers this per-user folder at install; the older Squirrel
      // installer used AnthropicClaude. The package family name is fixed by Anthropic's signature.
      return await this.exists(path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc')) ||
        await this.exists(path.join(local, 'AnthropicClaude', 'claude.exe'))
    }
    return false
  }

  async latest(id: ShellId): Promise<string> {
    const recipe = this.deps.recipes().shells[id]
    if (recipe.latest) return recipe.latest
    if (!recipe.npmPackage) return ''
    const now = (this.deps.now ?? Date.now)()
    const cached = this.latestCache.get(recipe.npmPackage)
    if (cached && now - cached.at < LATEST_CACHE_MS) return cached.version
    for (const registry of npmRegistries) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8_000)
      try {
        const response = await (this.deps.fetch ?? fetch)(`${registry}/${recipe.npmPackage}/latest`, { signal: controller.signal })
        if (!response.ok) continue
        const data = await response.json() as { version?: unknown }
        const version = typeof data.version === 'string' ? parseVersion(data.version) : ''
        if (version) { this.latestCache.set(recipe.npmPackage, { version, at: now }); return version }
      } catch { /* 换下一个来源。 */ }
      finally { clearTimeout(timer) }
    }
    return ''
  }

  /**
   * A PATH entry is useful presence evidence, but it is never an execution trust boundary. Even
   * `--version` can invoke a customer wrapper, so ordinary shells get an explicit unknown version
   * until their installation can be tied to a future trusted-candidate policy.
   */
  private async probePassiveCommand(command: string): Promise<{ version: string; location: string; versionUnknown: boolean } | undefined> {
    const directories = commandSearchDirectories(this.deps.platform, this.deps.home, this.deps.env)
    const names = commandNames(this.deps.platform, command)
    for (const directory of directories) {
      for (const name of names) {
        const candidate = join(directory, name)
        if (!await this.exists(candidate)) continue
        return { version: '', location: candidate, versionUnknown: true }
      }
    }
    return undefined
  }

  /** Codex/Claude inventory may display an untrusted PATH hit, but never execute it. */
  private async probeTrustedCommand(shell: Extract<TrustedCliShell, 'codex' | 'claude-code'>, command: string): Promise<{ version: string; location: string; versionUnknown: boolean } | undefined> {
    const trusted = await this.trustedVersion(shell, this.deps.platform, this.deps.home, this.deps.env)
    if (trusted !== undefined) return { version: trusted.version, location: trusted.executable, versionUnknown: trusted.versionUnknown }
    let fixedHit: string | undefined
    for (const candidate of await trustedCliCommandCandidates(shell, this.deps.platform, this.deps.home, this.deps.env)) {
      if (await this.exists(candidate)) { fixedHit = candidate; break }
    }
    const pathHit = shell === 'claude-code' ? await this.claudePathHit() : await findCommandPath(command, this.deps.platform, this.deps.home, this.deps.env, this.exists)
    const location = fixedHit ?? pathHit
    return location === undefined ? undefined : { version: '', location, versionUnknown: true }
  }

  /**
   * Hermes wrappers discovered through PATH have previously modified customer proxy state. A
   * discovered wrapper is useful installation evidence, but only the documented virtualenv
   * console script is executable, including when the user relocated HERMES_HOME.
   */
  private async probeHermesCommand(command: string): Promise<{ version: string; location: string; versionUnknown: boolean } | undefined> {
    const root = configuredHermesRoot(this.deps.platform, this.deps.home, this.deps.env)
    let trustedFound: string | undefined
    const candidates = trustedHermesCommandCandidates(this.deps.platform, root)
    for (const candidate of candidates) {
      if (!await this.exists(candidate)) continue
      trustedFound ??= candidate
      if (!await this.validateHermesExecutable(candidate, this.deps.platform)) continue
      try {
        const output = await this.exec(candidate, ['--version'], trustedHermesEnvironment(this.deps.platform, root, this.environment()))
        const version = parseVersion(output)
        if (version) return { version, location: candidate, versionUnknown: false }
      } catch { /* A trusted candidate that cannot report a version stays unknown. */ }
    }
    // Keep a visible “installed but cannot verify” state for a PATH hit, without executing it.
    let pathHit: string | undefined
    for (const candidate of commandCandidates(command, this.deps.platform, this.deps.home, this.deps.env)) {
      if (await this.exists(candidate)) { pathHit = candidate; break }
    }
    const location = trustedFound ?? pathHit
    return location === undefined ? undefined : { version: '', location, versionUnknown: true }
  }

  private async probeMacApp(names: readonly string[]): Promise<{ version: string; location: string; versionUnknown: boolean } | undefined> {
    for (const root of ['/Applications', join(this.deps.home, 'Applications')]) {
      for (const name of names) {
        const plist = join(root, name, 'Contents', 'Info.plist')
        if (!await this.exists(plist)) continue
        try {
          const output = await this.exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], this.deps.env)
          const version = parseVersion(output)
          // 读不出版本与读失败同义:都标未知,让闸门按不通过处理。
          return { version, location: join(root, name), versionUnknown: !version }
        } catch { return { version: '', location: join(root, name), versionUnknown: true } }
      }
    }
    return undefined
  }
}
