import { execFile as execFileCallback } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { CodexDesktopRouteReason, CodexDesktopRouteVerification } from '../../shared/api-service-types'

/** A request socket is the only thing inspected. Its body, headers and command line are never read here. */
export interface GatewaySocketBinding {
  readonly localAddress?: string
  readonly localPort?: number
  readonly remoteAddress?: string
  readonly remotePort?: number
}

export interface DesktopRouteAttestor {
  observe(socket: GatewaySocketBinding): Promise<CodexDesktopRouteVerification>
}

export interface DesktopRouteCommandResult {
  readonly exitCode: number
  /** Internal, bounded command text. Callers must reduce it to a fixed result before returning. */
  readonly output: string
}

export interface DesktopRouteCommandExecutor {
  run(command: string, args: readonly string[]): Promise<DesktopRouteCommandResult>
}

export interface DesktopRouteAttestationOptions {
  readonly platform?: NodeJS.Platform
  readonly executor?: DesktopRouteCommandExecutor
  /** Test seam. Production resolves only the bundle extracted from a live process executable. */
  readonly resolveRealPath?: (path: string) => Promise<string>
}

const lsof = '/usr/sbin/lsof'
const ps = '/bin/ps'
const codesign = '/usr/bin/codesign'
const officialCodexBundleIdentifier = 'com.openai.codex'
// The macOS release client observed on the release-validation host is signed by this OpenAI team.
// Verify both this stable signer and the exact bundle identifier; a process merely named "Codex" never qualifies.
const officialCodexTeamIdentifier = '2DC432GLL2'
const commandTimeoutMs = 700
const commandMaxBufferBytes = 64 * 1024
const observationTimeoutMs = 1_500

/**
 * macOS is the only supported proof surface today. `lsof` maps this exact live TCP tuple to a
 * PID, then the process executable's enclosing bundle is signature-verified. Windows and Linux
 * have no equally reliable same-user socket-to-process binding in the shipped runtime, so they
 * deliberately remain unverified instead of guessing from User-Agent, a time window or a claim.
 */
export function createDesktopRouteAttestor(options: DesktopRouteAttestationOptions = {}): DesktopRouteAttestor {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return unavailableDesktopRouteAttestor('platform_unsupported')
  const executor = options.executor ?? defaultExecutor()
  const resolveRealPath = options.resolveRealPath ?? realpath
  return {
    async observe(socket) {
      return within(macDesktopRouteAttestation(socket, executor, resolveRealPath), observationTimeoutMs,
        unverified('socket_binding_unavailable'))
    }
  }
}

/** Used by isolated unit tests and any runtime which has intentionally not installed the macOS observer. */
export function unavailableDesktopRouteAttestor(reason: CodexDesktopRouteReason = 'socket_binding_unavailable'): DesktopRouteAttestor {
  return { observe: async () => unverified(reason) }
}

export function unverified(reason: CodexDesktopRouteReason): CodexDesktopRouteVerification {
  return { status: 'unverified', at: null, reason }
}

function verified(at: string): CodexDesktopRouteVerification {
  return { status: 'verified', at, reason: 'verified_socket_bound_desktop' }
}

async function macDesktopRouteAttestation(
  socket: GatewaySocketBinding,
  executor: DesktopRouteCommandExecutor,
  resolveRealPath: (path: string) => Promise<string>
): Promise<CodexDesktopRouteVerification> {
  const binding = validLoopbackBinding(socket)
  if (binding === undefined) return unverified('socket_metadata_unavailable')

  let owners: readonly number[]
  try {
    // Do not filter this to the gateway's local port: that would omit the client's opposite
    // endpoint on some lsof versions. Parse the exact tuple below and fail closed if its bounded
    // snapshot cannot show one unique process.
    const result = await executor.run(lsof, ['-nP', '-Fpn', '-a', '-iTCP', '-sTCP:ESTABLISHED'])
    if (result.exitCode !== 0) return unverified('socket_binding_unavailable')
    owners = macSocketOwnerPids(result.output, binding.localPort, binding.remotePort)
  } catch {
    return unverified('socket_binding_unavailable')
  }
  if (owners.length === 0) return unverified('socket_owner_not_found')
  if (owners.length !== 1) return unverified('socket_owner_ambiguous')

  let executable: string | undefined
  try {
    const result = await executor.run(ps, ['-p', String(owners[0]), '-o', 'comm='])
    if (result.exitCode !== 0) return unverified('socket_owner_not_codex_desktop')
    executable = singleAbsolutePath(result.output)
  } catch {
    return unverified('socket_binding_unavailable')
  }
  const bundle = executable === undefined ? undefined : appBundleForExecutable(executable)
  if (bundle === undefined) return unverified('socket_owner_not_codex_desktop')

  let canonicalBundle: string
  try {
    canonicalBundle = await resolveRealPath(bundle)
  } catch {
    return unverified('desktop_signature_unverified')
  }
  if (!isAppBundle(canonicalBundle)) return unverified('desktop_signature_unverified')

  try {
    const integrity = await executor.run(codesign, ['--verify', '--deep', '--strict', canonicalBundle])
    if (integrity.exitCode !== 0) return unverified('desktop_signature_unverified')
    const identity = await executor.run(codesign, ['-d', '--verbose=4', canonicalBundle])
    if (identity.exitCode !== 0 || !isOfficialCodexSignature(identity.output)) return unverified('desktop_signature_unverified')
  } catch {
    return unverified('desktop_signature_unverified')
  }
  return verified(new Date().toISOString())
}

interface ValidLoopbackBinding {
  readonly localPort: number
  readonly remotePort: number
}

function validLoopbackBinding(value: GatewaySocketBinding): ValidLoopbackBinding | undefined {
  if (!isLoopbackAddress(value.localAddress) || !isLoopbackAddress(value.remoteAddress) ||
    !validPort(value.localPort) || !validPort(value.remotePort)) return undefined
  return { localPort: value.localPort, remotePort: value.remotePort }
}

function isLoopbackAddress(value: unknown): boolean {
  return value === '127.0.0.1' || value === '::ffff:127.0.0.1'
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

/**
 * `lsof -Fpn` returns only PID and network-name fields. We use the PID only when
 * its client-side endpoint exactly reverses the accepted gateway socket; the gateway's own
 * server-side entry therefore cannot match. No command name or network tuple leaves this module.
 */
export function macSocketOwnerPids(output: string, localPort: number, remotePort: number): readonly number[] {
  if (!validPort(localPort) || !validPort(remotePort) || output.length > commandMaxBufferBytes) return []
  const result = new Set<number>()
  let pid: number | undefined
  for (const raw of output.split(/\r?\n/)) {
    if (raw.startsWith('p')) {
      const next = Number(raw.slice(1))
      pid = Number.isSafeInteger(next) && next > 0 ? next : undefined
      continue
    }
    if (pid !== undefined && raw.startsWith('n') && exactClientSocket(raw.slice(1), localPort, remotePort)) result.add(pid)
  }
  return [...result]
}

function exactClientSocket(value: string, localPort: number, remotePort: number): boolean {
  return value.trim().replace(/\s+\(ESTABLISHED\)$/i, '') ===
    `127.0.0.1:${String(remotePort)}->127.0.0.1:${String(localPort)}`
}

function singleAbsolutePath(value: string): string | undefined {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length !== 1 || lines[0].length > 4_096 || !lines[0].startsWith('/') || lines[0].includes('\0')) return undefined
  return lines[0]
}

/** The installed Desktop may be branded `ChatGPT.app` while its signed bundle is `com.openai.codex`. */
function appBundleForExecutable(executable: string): string | undefined {
  const segments = executable.split('/')
  const index = segments.findIndex(segment => segment.endsWith('.app') && segment.length > '.app'.length)
  return index > 0 ? segments.slice(0, index + 1).join('/') : undefined
}

function isAppBundle(bundle: string): boolean {
  return bundle.startsWith('/') && bundle.split('/').at(-1)?.endsWith('.app') === true && !bundle.includes('\0')
}

function isOfficialCodexSignature(value: string): boolean {
  return new RegExp(`^Identifier=${escapeRegex(officialCodexBundleIdentifier)}\\s*$`, 'm').test(value) &&
    new RegExp(`^TeamIdentifier=${escapeRegex(officialCodexTeamIdentifier)}\\s*$`, 'm').test(value)
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

async function within<T>(operation: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs) })
  try { return await Promise.race([operation, timeout]) } finally { if (timer !== undefined) clearTimeout(timer) }
}

const execFile = promisify(execFileCallback)

function defaultExecutor(): DesktopRouteCommandExecutor {
  return {
    async run(command, args) {
      try {
        const result = await execFile(command, [...args], {
          shell: false,
          timeout: commandTimeoutMs,
          maxBuffer: commandMaxBufferBytes,
          windowsHide: true,
          encoding: 'utf8'
        })
        return { exitCode: 0, output: bounded(`${result.stdout}${result.stderr}`) }
      } catch (error) {
        // `execFile` errors may carry command text or OS detail. Reduce them to a fixed exit code;
        // an unavailable probe is never a reason to expose a process, path or socket to the UI.
        const result = error as { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown }
        return {
          exitCode: typeof result.code === 'number' ? result.code : 1,
          output: bounded(`${typeof result.stdout === 'string' ? result.stdout : ''}${typeof result.stderr === 'string' ? result.stderr : ''}`)
        }
      }
    }
  }
}

function bounded(value: string): string { return value.slice(0, commandMaxBufferBytes) }
