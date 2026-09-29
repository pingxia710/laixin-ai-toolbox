import { app } from 'electron'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AiGateway } from './gateway'
import { createDesktopRouteAttestor } from './desktop-route-attestation'
import { activeRouterRoute, readRouterBusinessState } from './router-state'
import { acquireAiRouterSeat, readAiRouterRuntime, removeAiRouterRuntime, writeAiRouterRuntime, type AiRouterSeatOwner } from './router-runtime'
import { routerControlProtocolVersion, routerControlTimeoutMs, routerDrainTimeoutMs, routerNonce, routerProof, sameRouterProof,
  routerReadyPath, routerRefreshPath, routerStopPath } from './router-protocol'
import type { AiAccessState } from './service'
import { removeAiRouterResident } from './router-resident'

export interface ExecutableRemovalMonitorOptions {
  readonly intervalMs?: number
  readonly stat?: typeof lstat
}

/** Two consecutive ENOENT observations avoid treating a transient filesystem error as uninstall. */
export function startExecutableRemovalMonitor(executable: string, onRemoved: () => Promise<void>, options: ExecutableRemovalMonitorOptions = {}): () => void {
  let missing = 0
  let checking = false
  let finished = false
  const timer = setInterval(() => {
    if (checking || finished) return
    checking = true
    void (options.stat ?? lstat)(executable).then(() => { missing = 0 }, error => {
      missing = (error as NodeJS.ErrnoException).code === 'ENOENT' ? missing + 1 : 0
    }).then(async () => {
      if (missing < 2 || finished) return
      try { await onRemoved(); finished = true } catch { /* keep retrying while the removed app is still running */ }
    }).finally(() => { checking = false })
  }, options.intervalMs ?? 1_000)
  timer.unref?.()
  return () => clearInterval(timer)
}

interface HeadlessRouterControlOptions {
  readonly binding: { readonly port: number; readonly identitySecret: string }
  readonly bootId: string
  readonly initialModelCount: number
  readonly readState: () => Promise<AiAccessState>
  readonly gateway: () => AiGateway
  readonly onStop: () => void
}

/** One bounded control transaction; Desktop proof is only an already-settled status snapshot. */
export function createHeadlessRouterControl(options: HeadlessRouterControlOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let modelCount = options.initialModelCount
  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(options.binding.port)}`)
    const nonce = req.method === 'GET' ? url.searchParams.get('nonce') : req.headers['x-laixin-nonce']
    const action = url.pathname === routerReadyPath ? 'ready' : url.pathname === routerRefreshPath ? 'refresh' : url.pathname === routerStopPath ? 'stop' : ''
    if (!action || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) ||
      (action === 'ready' ? req.method !== 'GET' : req.method !== 'POST')) { res.writeHead(404); res.end(); return }
    if (action !== 'ready' && !sameRouterProof(req.headers['x-laixin-proof'],
      routerProof(options.binding.identitySecret, action, nonce, options.bootId, options.binding.port))) {
      res.writeHead(403); res.end(); return
    }
    const gateway = options.gateway()
    if (action === 'refresh') {
      try {
        const current = await options.readState()
        if (current.codexMultiRelay?.port !== options.binding.port ||
          current.codexMultiRelay.identitySecret !== options.binding.identitySecret) { res.writeHead(409); res.end(); return }
        const next = activeRouterRoute(current)
        if (!next) { res.writeHead(409); res.end(); return }
        gateway.setMultiModelRoute(next)
        modelCount = next.models.length
      } catch { res.writeHead(409); res.end(); return }
    }
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'application/json')
    const lastDesktopUse = gateway.latestSettledMultiModelDesktopUse()
    res.end(JSON.stringify({ protocol: routerControlProtocolVersion, pid: process.pid, bootId: options.bootId,
      proof: routerProof(options.binding.identitySecret, `${action}-ack`, nonce, options.bootId, options.binding.port),
      models: modelCount, ...(lastDesktopUse ? { lastDesktopUse } : {}) }))
    if (action === 'stop') setImmediate(options.onStop)
  }
}

async function provesCurrentHeadlessRouter(root: string, binding: { readonly port: number; readonly identitySecret: string }, owner: AiRouterSeatOwner): Promise<boolean> {
  const runtime = await readAiRouterRuntime(root)
  if (!runtime || runtime.pid !== owner.pid || runtime.bootId !== owner.bootId || runtime.port !== binding.port) return false
  const nonce = routerNonce()
  try {
    const response = await fetch(`http://127.0.0.1:${String(binding.port)}${routerReadyPath}?nonce=${nonce}`, {
      signal: AbortSignal.timeout(routerControlTimeoutMs)
    })
    if (!response.ok) return false
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object') return false
    const proof = value as { pid?: unknown; bootId?: unknown; proof?: unknown }
    return proof.pid === owner.pid && proof.bootId === owner.bootId &&
      sameRouterProof(proof.proof, routerProof(binding.identitySecret, 'ready-ack', nonce, owner.bootId, binding.port))
  } catch { return false }
}

export async function runHeadlessRouter(userData = app.getPath('userData')): Promise<void> {
  const root = join(userData, 'ai-access')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const initial = await readRouterBusinessState(userData).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!initial) { app.exit(0); return }
  const binding = initial.codexMultiRelay
  const route = activeRouterRoute(initial)
  if (!binding || !route) { app.exit(0); return }
  const seat = await acquireAiRouterSeat(root, owner => provesCurrentHeadlessRouter(root, binding, owner))
  const token = randomBytes(32).toString('hex')
  const gatewayHolder: { current?: AiGateway } = {}
  let stopping = false
  let stopRemovalMonitor: (() => void) | undefined
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    stopRemovalMonitor?.()
    await gatewayHolder.current?.drain(routerDrainTimeoutMs).catch(() => undefined)
    await removeAiRouterRuntime(root, seat.bootId)
    await seat.release()
    app.exit(0)
  }
  const control = createHeadlessRouterControl({ binding, bootId: seat.bootId, initialModelCount: route.models.length,
    readState: () => readRouterBusinessState(userData), gateway: () => gatewayHolder.current!, onStop: () => { void stop() } })
  const gateway = new AiGateway({ desktopAttestor: createDesktopRouteAttestor(), routerControl: control })
  gatewayHolder.current = gateway
  try {
    await seat.assertOwnership()
    await gateway.start(binding.port, token)
    await seat.assertOwnership()
    gateway.setMultiModelRoute(route)
    await writeAiRouterRuntime(root, { pid: process.pid, bootId: seat.bootId, port: binding.port, token })
    await seat.assertOwnership()
    process.once('SIGTERM', () => { void stop() })
    process.once('SIGINT', () => { void stop() })
    if (app.isPackaged) {
      stopRemovalMonitor = startExecutableRemovalMonitor(process.execPath, async () => {
        await removeAiRouterResident()
        await stop()
      })
    }
  } catch (error) {
    await gateway.stop().catch(() => undefined)
    await seat.release()
    throw error
  }
}
