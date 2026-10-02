import { spawn } from 'node:child_process'
import { createServer, createConnection } from 'node:net'
import { join } from 'node:path'
import type { AiAccessState } from './service'
import type { MultiModelDesktopUse } from './gateway'
import { activeRouterRoute, routerConfigured } from './router-state'
import type { RouterGatewaySnapshot, RouterIsolationCommand } from './router-gateway'
import { readAiRouterRuntime, readAiRouterSeat, removeAiRouterRuntime, removeAiRouterSeat, type AiRouterRuntime } from './router-runtime'
import { routerControlProtocolVersion, routerControlTimeoutMs, routerDrainTimeoutMs, routerNonce, routerProof, routerReadyPath,
  routerBodyHash, routerIsolationPath, routerRefreshPath, routerSnapshotPath, routerStartupTimeoutMs, routerStopPath, sameRouterProof } from './router-protocol'
import { AI_ROUTER_ARGUMENT, installAiRouterResident, removeAiRouterResident, wakeAiRouterResident, type AiRouterResidentSpec } from './router-resident'

export interface RouterReady { readonly runtime: AiRouterRuntime; readonly baseUrl: string }
export type AiRouterSafeError = 'not_configured' | 'not_running' | 'port_conflict' | 'stale_route' | 'protocol_incompatible'
export interface AiRouterPublicStatus {
  readonly running: boolean
  readonly modelCount: number
  readonly lastDesktopUse?: MultiModelDesktopUse
  readonly error?: AiRouterSafeError
}

type RouterControlResult =
  | { readonly kind: 'verified'; readonly value: Record<string, unknown> }
  | { readonly kind: 'protocol_incompatible'; readonly value: Record<string, unknown> }
  | { readonly kind: 'unavailable' }

export async function chooseAiRouterPort(): Promise<number> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AI_ROUTER_PORT_TIMEOUT')), routerControlTimeoutMs)
      server.once('error', error => { clearTimeout(timer); reject(error) })
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve() })
    })
  } catch (error) { try { server.close() } catch { /* not listening */ }; throw error }
  const address = server.address()
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('AI_ROUTER_PORT_UNAVAILABLE')
  return address.port
}

async function portOccupied(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (occupied: boolean) => { socket.destroy(); resolve(occupied) }
    socket.setTimeout(300, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export class AiRouterController {
  private installedBootId?: string
  private residentInstallation?: Promise<void>
  constructor(private readonly userData: string, private readonly spec: AiRouterResidentSpec,
    private readonly options: { readonly preferSpawn?: boolean } = {}) {}

  private async proofRequest(state: AiAccessState, action: 'ready' | 'refresh' | 'stop' | 'snapshot' | 'isolation', runtime: AiRouterRuntime,
    body?: string): Promise<RouterControlResult> {
    const secret = state.codexMultiRelay?.identitySecret
    if (!secret || runtime.port !== state.codexMultiRelay?.port) return { kind: 'unavailable' }
    const nonce = routerNonce()
    const path = action === 'ready' ? routerReadyPath : action === 'refresh' ? routerRefreshPath : action === 'snapshot' ? routerSnapshotPath
      : action === 'isolation' ? routerIsolationPath : routerStopPath
    const hash = body === undefined ? undefined : routerBodyHash(body)
    const proofAction = hash === undefined ? action : `${action}:${hash}`
    try {
      const response = await fetch(`http://127.0.0.1:${String(runtime.port)}${path}${action === 'ready' ? `?nonce=${nonce}` : ''}`, {
        method: action === 'ready' ? 'GET' : 'POST',
        headers: {
          'x-laixin-nonce': nonce,
          'x-laixin-proof': routerProof(secret, proofAction, nonce, runtime.bootId, runtime.port),
          ...(hash ? { 'x-laixin-body-hash': hash, 'content-type': 'application/json' } : {})
        },
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(action === 'isolation' ? 6_000 : routerControlTimeoutMs)
      })
      if (!response.ok) return { kind: 'unavailable' }
      const replyBody = await response.text()
      if (Buffer.byteLength(replyBody) > 256 * 1024) return { kind: 'unavailable' }
      const value = asRecord(JSON.parse(replyBody) as unknown)
      if (value?.bootId !== runtime.bootId || value.pid !== runtime.pid ||
        !sameRouterProof(value.proof, routerProof(secret, `${proofAction}-ack`, nonce, runtime.bootId, runtime.port))) return { kind: 'unavailable' }
      if (value.protocol !== routerControlProtocolVersion) return { kind: 'protocol_incompatible', value }
      return { kind: 'verified', value }
    } catch { return { kind: 'unavailable' } }
  }

  async probe(state: AiAccessState): Promise<RouterReady | undefined> {
    if (!routerConfigured(state)) return undefined
    const runtime = await readAiRouterRuntime(join(this.userData, 'ai-access'))
    if (!runtime || (await this.proofRequest(state, 'ready', runtime)).kind !== 'verified') return undefined
    return { runtime, baseUrl: `http://127.0.0.1:${String(runtime.port)}` }
  }

  async ensureReady(state: AiAccessState, install = false): Promise<RouterReady | undefined> {
    if (!routerConfigured(state)) return undefined
    let current = await this.probe(state)
    if (install && (!current || this.installedBootId !== current.runtime.bootId)) {
      this.installedBootId = undefined
      try {
        this.residentInstallation ??= installAiRouterResident(this.spec).finally(() => { this.residentInstallation = undefined })
        await this.residentInstallation
      } catch { return undefined }
      // Updating a resident definition may replace its process; never reuse the pre-install proof.
      current = await this.probe(state)
    }
    if (current) {
      if (install) this.installedBootId = current.runtime.bootId
      return current
    }
    if (await portOccupied(state.codexMultiRelay!.port)) return undefined
    let fallbackStarted = false
    if (!install && !(await portOccupied(state.codexMultiRelay!.port))) {
      if (this.options.preferSpawn) { this.spawnFallback(); fallbackStarted = true }
      else try { await wakeAiRouterResident() } catch { this.spawnFallback(); fallbackStarted = true }
    }
    const until = Date.now() + routerStartupTimeoutMs
    const fallbackAt = Date.now() + 1_000
    do {
      const ready = await this.probe(state)
      if (ready) {
        if (install) this.installedBootId = ready.runtime.bootId
        return ready
      }
      if (!fallbackStarted && Date.now() >= fallbackAt && !(await portOccupied(state.codexMultiRelay!.port))) {
        this.spawnFallback()
        fallbackStarted = true
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < until)
    return undefined
  }

  private spawnFallback(): void {
    const args = [...(this.spec.appPath ? [this.spec.appPath] : []), AI_ROUTER_ARGUMENT]
    const child = spawn(this.spec.executable, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => undefined)
    child.unref()
  }

  async refresh(state: AiAccessState): Promise<boolean> {
    const ready = await this.ensureReady(state, true)
    if (!ready) return false
    return (await this.proofRequest(state, 'refresh', ready.runtime)).kind === 'verified'
  }

  /** Authenticated, settled facts from the listener used by single-model clients. */
  async gatewaySnapshot(state: AiAccessState): Promise<RouterGatewaySnapshot | undefined> {
    const runtime = await readAiRouterRuntime(join(this.userData, 'ai-access'))
    if (!runtime) return undefined
    const result = await this.proofRequest(state, 'snapshot', runtime)
    if (result.kind !== 'verified') return undefined
    const snapshot = asRecord(result.value.singleGateway)
    const service = asRecord(snapshot?.service)
    if (!snapshot || !service || typeof service.running !== 'boolean' || !Array.isArray(service.routes) ||
      !Array.isArray(service.requests) || !asRecord(snapshot.acceptances) || !asRecord(snapshot.attempts) || !asRecord(snapshot.desktop)) return undefined
    return snapshot as unknown as RouterGatewaySnapshot
  }

  async isolation(state: AiAccessState, command: RouterIsolationCommand): Promise<unknown> {
    const ready = await this.probe(state)
    if (!ready) throw new Error('AI_ROUTER_UNAVAILABLE')
    const result = await this.proofRequest(state, 'isolation', ready.runtime, JSON.stringify(command))
    if (result.kind !== 'verified') throw new Error('AI_ROUTER_ISOLATION_FAILED')
    return result.value.data
  }

  async stop(state: AiAccessState): Promise<boolean> {
    this.installedBootId = undefined
    const root = join(this.userData, 'ai-access')
    const runtime = await readAiRouterRuntime(root)
    if (!runtime) {
      await removeAiRouterResident()
      const configuredPort = state.codexMultiRelay?.port
      return configuredPort === undefined || !(await portOccupied(configuredPort))
    }
    const ready = await this.proofRequest(state, 'ready', runtime)
    if (ready.kind === 'unavailable') return false
    const seat = await readAiRouterSeat(root)
    if (!seat?.holder || seat.holder.pid !== runtime.pid || seat.holder.bootId !== runtime.bootId) return false
    const stop = await this.proofRequest(state, 'stop', runtime)
    if (stop.kind === 'unavailable') throw new Error('AI_ROUTER_STOP_UNCERTAIN')
    try { await removeAiRouterResident() }
    catch (error) { throw new Error('AI_ROUTER_STOP_INCOMPLETE', { cause: error }) }
    const clearVerifiedOwner = async (): Promise<boolean> => {
      try {
        await removeAiRouterRuntime(root, runtime.bootId)
        await removeAiRouterSeat(root, seat)
        return !(await readAiRouterRuntime(root)) && !(await readAiRouterSeat(root))
      } catch { return false }
    }
    const until = Date.now() + routerDrainTimeoutMs + 1_000
    while (Date.now() < until) {
      if (!(await portOccupied(runtime.port))) {
        if (await clearVerifiedOwner()) return true
        throw new Error('AI_ROUTER_STOP_INCOMPLETE')
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const current = await readAiRouterRuntime(root)
    const currentSeat = await readAiRouterSeat(root)
    if (current?.pid === runtime.pid && current.bootId === runtime.bootId && current.port === runtime.port &&
      currentSeat !== undefined && currentSeat.raw.equals(seat.raw)) {
      try { process.kill(runtime.pid, 'SIGTERM') } catch { /* already exited */ }
      const killedUntil = Date.now() + 2_000
      while (Date.now() < killedUntil && await portOccupied(runtime.port)) await new Promise(resolve => setTimeout(resolve, 50))
      if (!(await portOccupied(runtime.port))) {
        if (await clearVerifiedOwner()) return true
        throw new Error('AI_ROUTER_STOP_INCOMPLETE')
      }
    }
    throw new Error('AI_ROUTER_STOP_INCOMPLETE')
  }

  async status(state: AiAccessState): Promise<AiRouterPublicStatus> {
    const modelCount = state.codexMultiModelPool?.length ?? 0
    if (!activeRouterRoute(state)) return { running: false, modelCount, error: 'not_configured' }
    const runtime = await readAiRouterRuntime(join(this.userData, 'ai-access'))
    if (!runtime) return { running: false, modelCount, error: 'not_running' }
    const result = await this.proofRequest(state, 'ready', runtime)
    if (result.kind === 'protocol_incompatible') return { running: false, modelCount, error: 'protocol_incompatible' }
    if (result.kind !== 'verified') return { running: false, modelCount, error: await portOccupied(state.codexMultiRelay!.port) ? 'port_conflict' : 'not_running' }
    const value = result.value
    if (value.models !== modelCount) return { running: false, modelCount, error: 'stale_route' }
    const lastDesktopUse = safeDesktopUse(value.lastDesktopUse, state)
    return { running: true, modelCount, ...(lastDesktopUse ? { lastDesktopUse } : {}) }
  }
}

function safeDesktopUse(value: unknown, state: AiAccessState): MultiModelDesktopUse | undefined {
  const record = asRecord(value)
  if (!record || typeof record.provider !== 'string' || typeof record.model !== 'string' ||
    typeof record.internalModelId !== 'string' || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) return undefined
  const entry = state.codexMultiModelPool?.find(candidate => candidate.provider === record.provider && candidate.model === record.model &&
    candidate.internalModelId === record.internalModelId)
  return entry ? { ...entry, at: record.at } : undefined
}
