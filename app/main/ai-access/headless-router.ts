import { app, session } from 'electron'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AiGateway } from './gateway'
import { AiRouterGateway, type RouterGatewaySnapshot, type RouterIsolationCommand } from './router-gateway'
import { ApplicationIsolationHttpConnectTransport } from './application-isolation-transport'
import { createDesktopRouteAttestor } from './desktop-route-attestation'
import { activeRouterRoute, readRouterBusinessState, routerConfigured } from './router-state'
import { RecipeStore, recipeFile } from '../recipes/store'
import { resolveProviderRoute } from '../recipes/recipes'
import { modelProviders } from '../../shared/model-providers'
import { acquireAiRouterSeat, readAiRouterRuntime, removeAiRouterRuntime, writeAiRouterRuntime, type AiRouterSeatOwner } from './router-runtime'
import { routerControlProtocolVersion, routerControlTimeoutMs, routerDrainTimeoutMs, routerNonce, routerProof, sameRouterProof,
  routerBodyHash, routerIsolationPath, routerReadyPath, routerRefreshPath, routerSnapshotPath, routerStopPath } from './router-protocol'
import type { AiAccessState } from './service'
import { removeAiRouterResident } from './router-resident'
import { recordFault } from '../diagnostics/context'
import { detachAiRouterConnections } from './router-cleanup'
import { API_NETWORK_PATH } from '../../../sidecar/shared/api-network-continuation.mjs'

declare const __TOOLBOX_UPDATE_PUBLIC_KEY__: string
declare const __TOOLBOX_UPDATE_ORIGIN__: string

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
  readonly refresh?: (state: AiAccessState) => Promise<void>
  readonly snapshot?: () => RouterGatewaySnapshot
  readonly network?: () => ReturnType<AiRouterGateway['networkUse']>
  readonly isolation?: (command: RouterIsolationCommand, state: AiAccessState) => Promise<unknown>
}

/** One bounded control transaction; Desktop proof is only an already-settled status snapshot. */
export function createHeadlessRouterControl(options: HeadlessRouterControlOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let modelCount = options.initialModelCount
  let closing = false
  let pending = Promise.resolve()
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(() => { if (closing) throw new Error('AI_ROUTER_STOPPING'); return operation() })
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(options.binding.port)}`)
    const nonce = req.method === 'GET' ? url.searchParams.get('nonce') : req.headers['x-laixin-nonce']
    const action = url.pathname === routerReadyPath ? 'ready' : url.pathname === routerRefreshPath ? 'refresh' : url.pathname === routerStopPath ? 'stop'
      : url.pathname === routerSnapshotPath && options.snapshot ? 'snapshot'
        : url.pathname === API_NETWORK_PATH && options.network ? 'network'
        : url.pathname === routerIsolationPath && options.isolation ? 'isolation' : ''
    if (!action || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) ||
      (action === 'ready' ? req.method !== 'GET' : req.method !== 'POST')) { res.writeHead(404); res.end(); return }
    const hash = action === 'isolation' ? req.headers['x-laixin-body-hash'] : undefined
    if (action === 'isolation' && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) { res.writeHead(403); res.end(); return }
    const proofAction = hash === undefined ? action : `${action}:${String(hash)}`
    if (!sameRouterProof(req.headers['x-laixin-proof'],
      routerProof(options.binding.identitySecret, proofAction, nonce, options.bootId, options.binding.port))) {
      res.writeHead(403); res.end(); return
    }
    const gateway = options.gateway()
    let data: unknown
    if (action === 'isolation') {
      try {
        let body = ''
        for await (const chunk of req) {
          body += String(chunk)
          if (Buffer.byteLength(body) > 4096) { res.writeHead(413); res.end(); return }
        }
        if (routerBodyHash(body) !== hash) { res.writeHead(403); res.end(); return }
        const command = JSON.parse(body) as RouterIsolationCommand
        if (!command || !['codex', 'claude', 'hermes'].includes(command.shell) ||
          !['activate', 'apply', 'deactivate', 'diagnostic', 'probe-accepted', 'status'].includes(command.action) ||
          command.action === 'activate' && typeof command.proxyUrl !== 'string' ||
          (command.action === 'activate' || command.action === 'apply' || command.action === 'probe-accepted') && !/^[a-f0-9]{64}$/.test(command.targetIdentity) ||
          command.action === 'diagnostic' && typeof command.revision !== 'string') { res.writeHead(409); res.end(); return }
        data = await mutate(async () => {
          const current = await options.readState()
          if (current.codexMultiRelay?.identitySecret !== options.binding.identitySecret || current.codexMultiRelay.port !== options.binding.port) throw new Error('AI_ROUTER_BINDING_CHANGED')
          return options.isolation!(command, current)
        })
      } catch { res.writeHead(409); res.end(); return }
    }
    if (action === 'refresh') {
      try {
        await mutate(async () => {
          const current = await options.readState()
          if (current.codexMultiRelay?.port !== options.binding.port || current.codexMultiRelay.identitySecret !== options.binding.identitySecret) throw new Error('AI_ROUTER_BINDING_CHANGED')
          const next = activeRouterRoute(current)
          if (options.refresh) await options.refresh(current)
          else {
            if (!next) throw new Error('AI_ROUTER_ROUTE_INVALID')
            gateway.setMultiModelRoute(next)
          }
          modelCount = next?.models.length ?? 0
        })
      } catch { res.writeHead(409); res.end(); return }
    }
    res.setHeader('cache-control', 'no-store')
    if (action === 'stop') closing = true
    res.setHeader('content-type', 'application/json')
    const lastDesktopUse = gateway.latestSettledMultiModelDesktopUse()
    res.end(JSON.stringify({ protocol: routerControlProtocolVersion, pid: process.pid, bootId: options.bootId,
      proof: routerProof(options.binding.identitySecret, `${proofAction}-ack`, nonce, options.bootId, options.binding.port),
      models: modelCount, ...(lastDesktopUse ? { lastDesktopUse } : {}),
      ...(action === 'network' ? { network: options.network!() } : {}),
      ...(action === 'snapshot' ? { singleGateway: options.snapshot!() } : {}), ...(data === undefined ? {} : { data }) }))
    if (action === 'stop') setImmediate(options.onStop)
  }
}

async function provesCurrentHeadlessRouter(root: string, binding: { readonly port: number; readonly identitySecret: string }, owner: AiRouterSeatOwner): Promise<boolean> {
  const runtime = await readAiRouterRuntime(root)
  if (!runtime || runtime.pid !== owner.pid || runtime.bootId !== owner.bootId || runtime.port !== binding.port) return false
  const nonce = routerNonce()
  try {
    const response = await fetch(`http://127.0.0.1:${String(binding.port)}${routerReadyPath}?nonce=${nonce}`, {
      headers: { 'x-laixin-proof': routerProof(binding.identitySecret, 'ready', nonce, owner.bootId, binding.port) },
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
  if (!binding || !routerConfigured(initial)) { app.exit(0); return }
  const seat = await acquireAiRouterSeat(root, owner => provesCurrentHeadlessRouter(root, binding, owner))
  const token = randomBytes(32).toString('hex')
  const gatewayHolder: { current?: AiRouterGateway } = {}
  let stopping = false
  let stopRemovalMonitor: (() => void) | undefined
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    stopRemovalMonitor?.()
    await gatewayHolder.current?.stop(routerDrainTimeoutMs).catch(() => undefined)
    await removeAiRouterRuntime(root, seat.bootId)
    await seat.release()
    app.exit(0)
  }
  const loadRecipes = () => new RecipeStore({ file: recipeFile(userData), publicKey: __TOOLBOX_UPDATE_PUBLIC_KEY__, origin: __TOOLBOX_UPDATE_ORIGIN__ }).load()
  let recipes = await loadRecipes()
  const control = createHeadlessRouterControl({ binding, bootId: seat.bootId, initialModelCount: route?.models.length ?? 0,
    readState: () => readRouterBusinessState(userData), gateway: () => gatewayHolder.current!.primary,
    refresh: async state => { recipes = await loadRecipes(); await gatewayHolder.current!.refresh(state) },
    snapshot: () => gatewayHolder.current!.snapshot(), network: () => gatewayHolder.current!.networkUse(),
    isolation: (command, state) => gatewayHolder.current!.isolation(command, state),
    onStop: () => { void stop() } })
  const recentFaults = new Map<string, number>()
  const gateway = new AiRouterGateway({ desktopAttestor: createDesktopRouteAttestor(), routerControl: control,
    onClientFailure: record => {
      const code = record.code ?? 'unknown'
      const now = Date.now()
      const signature = `${record.shell}|${record.provider}|${code}`
      for (const [key, at] of recentFaults) if (now - at >= 60_000) recentFaults.delete(key)
      if (recentFaults.has(signature)) return
      recentFaults.set(signature, now)
      recordFault({ shell: record.shell, ...(record.provider ? { provider: record.provider } : {}), code })
    } },
    (shell, provider) => resolveProviderRoute(recipes, shell, provider,
      { endpoint: modelProviders[provider].endpoints[shell], model: modelProviders[provider].models[shell] }),
    (shell, id) => new ApplicationIsolationHttpConnectTransport({
      create: () => session.fromPartition(`toolbox-router-${shell}-${id}`, { cache: false })
    }))
  gatewayHolder.current = gateway
  try {
    await seat.assertOwnership()
    await gateway.start(initial, token)
    await seat.assertOwnership()
    await writeAiRouterRuntime(root, { pid: process.pid, bootId: seat.bootId, port: binding.port,
      token: initial.relay?.port === binding.port ? initial.relay.token : token })
    await seat.assertOwnership()
    process.once('SIGTERM', () => { void stop() })
    process.once('SIGINT', () => { void stop() })
    if (app.isPackaged) {
      stopRemovalMonitor = startExecutableRemovalMonitor(process.execPath, async () => {
        await detachAiRouterConnections(userData)
        await removeAiRouterResident()
        await stop()
      })
    }
  } catch (error) {
    await gateway.stop(0).catch(() => undefined)
    await seat.release()
    throw error
  }
}
