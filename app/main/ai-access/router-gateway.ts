import { AiGateway, type AiGatewayOptions, type GatewayRoute } from './gateway'
import type { AiAccessState } from './service'
import { activeRouterRoute, activeSingleRouterRoutes, type RouterRouteResolver } from './router-state'
import type { ClientRouteAcceptance, ClientRouteAttempt } from './client-acceptance'
import type { ApiServiceSnapshot, ApiShell, CodexDesktopRouteVerification } from '../../shared/api-service-types'
import { createHash, randomUUID } from 'node:crypto'
import type { ApplicationIsolationEgress } from './service'

export type RouterIsolationCommand =
  | { readonly shell: ApiShell; readonly action: 'activate'; readonly proxyUrl: string; readonly targetIdentity: string }
  | { readonly shell: ApiShell; readonly action: 'apply'; readonly targetIdentity: string; readonly lease?: RouterIsolationLease }
  | { readonly shell: ApiShell; readonly action: 'status' }
  | { readonly shell: ApiShell; readonly action: 'deactivate' }
  | { readonly shell: ApiShell; readonly action: 'diagnostic'; readonly revision: string }
  | { readonly shell: ApiShell; readonly action: 'probe-accepted'; readonly targetIdentity: string }

export interface RouterIsolationLease {
  readonly leaseId: string
  readonly configurationTargetIdentity: string
  readonly managedFingerprint: string
  readonly isolationFingerprint: string
}

export function routerRouteIdentity(route: { readonly provider: string; readonly key: string; readonly model: string; readonly endpoint: string }): string {
  return createHash('sha256').update(JSON.stringify([route.provider, route.key, route.model, route.endpoint])).digest('hex')
}

export interface RouterIsolationTransport extends ApplicationIsolationEgress {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

export interface RouterGatewaySnapshot {
  readonly service: Omit<ApiServiceSnapshot, 'checks' | 'usage'>
  readonly acceptances: Readonly<Partial<Record<ApiShell, ClientRouteAcceptance>>>
  readonly attempts: Readonly<Partial<Record<ApiShell, ClientRouteAttempt>>>
  readonly desktop: CodexDesktopRouteVerification
  /** 单模型监听被外部占用而降级(控制面与多模型仍活);端口释放后 refresh 自愈补起。 */
  readonly secondaryMissing?: true
}

/** One independent process preserves both historical listener addresses during migration. */
export class AiRouterGateway {
  readonly primary: AiGateway
  private secondary?: AiGateway
  private secondaryMissing = false
  private relay?: AiAccessState['relay']
  private routes: readonly GatewayRoute[] = []
  private stopping = false
  private readonly isolated = new Map<ApiShell, { id: string; targetIdentity: string; enabled: boolean; proxyUrl: string;
    accepted?: boolean; lease?: RouterIsolationLease }>()
  private readonly transports = new Map<string, RouterIsolationTransport>()
  private readonly gatewayOptions: AiGatewayOptions
  constructor(options: AiGatewayOptions, private readonly resolve?: RouterRouteResolver,
    private readonly createTransport?: (shell: ApiShell, id: string) => RouterIsolationTransport) {
    this.gatewayOptions = { ...options, fetch: (input, init, route) => {
      if (route?.isolated && route.egressId) {
        const transport = this.transports.get(route.egressId)
        if (!transport) return Promise.reject(new Error('APPLICATION_ISOLATION_ENTRY_UNAVAILABLE'))
        return transport.fetch(input.toString(), init)
      }
      return (options.fetch ?? fetch)(input, init, route)
    } }
    this.primary = new AiGateway(this.gatewayOptions)
  }

  async start(state: AiAccessState, token: string): Promise<void> {
    this.stopping = false
    const binding = state.codexMultiRelay!
    await this.primary.start(binding.port, state.relay?.port === binding.port ? state.relay.token : token)
    await this.refresh(state)
  }

  async refresh(state: AiAccessState): Promise<void> {
    if (this.stopping) throw new Error('AI_ROUTER_STOPPING')
    const relay = state.relay
    const primaryPort = Number(new URL(this.primary.baseUrl!).port)
    if (this.secondary && (relay?.port !== this.relay?.port || relay?.token !== this.relay?.token)) {
      await this.secondary.stop()
      this.secondary = undefined
    }
    if (this.stopping) throw new Error('AI_ROUTER_STOPPING')
    if (relay && relay.port !== primaryPort && !this.secondary) {
      const secondary = new AiGateway({ ...this.gatewayOptions, routerControl: undefined })
      try { await secondary.start(relay.port, relay.token) } catch (error) {
        await secondary.stop().catch(() => undefined)
        // 单模型端口被外部占用时降级:控制面与多模型监听不受连坐,进程不退出
        //(退出会被常驻 KeepAlive 无限拉起成重启循环);端口释放后下次 refresh 在此重试补起。
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') { this.secondaryMissing = true; this.relay = relay; return }
        throw error
      }
      this.secondaryMissing = false
      this.secondary = secondary
    }
    if (relay?.port === primaryPort && this.relay && relay.token !== this.relay.token) throw new Error('AI_ROUTER_BINDING_CHANGED')
    this.relay = relay
    const routes = activeSingleRouterRoutes(state, this.resolve).map(route => {
      const entry = this.isolated.get(route.shell)
      return entry?.enabled && entry.targetIdentity === routerRouteIdentity(route) ? { ...route, isolated: true, egressId: entry.id } : route
    })
    this.routes = routes
    this.primary.setRoutes(relay?.port === primaryPort ? routes : [])
    this.secondary?.setRoutes(routes)
    this.primary.setMultiModelRoute(activeRouterRoute(state))
  }

  singleGateway(): AiGateway { return this.secondary ?? this.primary }

  networkUse(): readonly { proxyUrl: string; targets: readonly string[] }[] {
    return this.routes.flatMap(route => {
      const entry = this.isolated.get(route.shell)
      if (!route.isolated || !entry?.enabled || !entry.accepted || entry.targetIdentity !== routerRouteIdentity(route)) return []
      const target = new URL(route.endpoint)
      return [{ proxyUrl: entry.proxyUrl, targets: [`${target.hostname}:${target.port || (target.protocol === 'https:' ? '443' : '80')}`] }]
    })
  }

  async isolation(command: RouterIsolationCommand, state: AiAccessState): Promise<unknown> {
    if (this.stopping) throw new Error('AI_ROUTER_STOPPING')
    if (command.action === 'diagnostic') return this.singleGateway().probeDiagnosticPath(command.shell, command.revision)
    if (command.action === 'probe-accepted') {
      const route = this.routes.find(route => route.shell === command.shell && routerRouteIdentity(route) === command.targetIdentity)
      if (route) {
        this.singleGateway().clearRetryBlock(route)
        const entry = this.isolated.get(command.shell)
        if (entry?.enabled && entry.targetIdentity === command.targetIdentity) entry.accepted = true
      }
      return undefined
    }
    const before = this.isolated.get(command.shell)
    if (command.action === 'status') {
      const route = this.routes.find(route => route.shell === command.shell)
      return before?.enabled && before.accepted && route?.isolated && before.targetIdentity === routerRouteIdentity(route)
        ? { targetIdentity: before.targetIdentity, proxyUrl: before.proxyUrl, lease: before.lease } : undefined
    }
    if (command.action === 'apply') {
      const route = activeSingleRouterRoutes(state, this.resolve).find(route => route.shell === command.shell)
      if (!route || !before || before.targetIdentity !== command.targetIdentity || routerRouteIdentity(route) !== command.targetIdentity) throw new Error('AI_ROUTER_ISOLATION_STALE')
      before.enabled = true
      before.lease = command.lease
      await this.refresh(state)
      return undefined
    }
    if (command.action === 'activate') {
      const route = activeSingleRouterRoutes(state, this.resolve).find(route => route.shell === command.shell)
      if (!route || routerRouteIdentity(route) !== command.targetIdentity || !this.createTransport) throw new Error('AI_ROUTER_ISOLATION_STALE')
      const id = randomUUID()
      const transport = this.createTransport(command.shell, id)
      await transport.activate(command.proxyUrl, route.endpoint)
      if (this.stopping) { await transport.deactivate(); throw new Error('AI_ROUTER_STOPPING') }
      this.transports.set(id, transport)
      this.isolated.set(command.shell, { id, targetIdentity: command.targetIdentity, enabled: false, proxyUrl: command.proxyUrl })
    } else this.isolated.delete(command.shell)
    await this.refresh(state)
    if (before) {
      const gateway = this.singleGateway()
      void gateway.settleCurrentRequests().then(async () => {
        await this.transports.get(before.id)?.deactivate()
        this.transports.delete(before.id)
      }).catch(() => undefined)
    }
    return undefined
  }

  snapshot(): RouterGatewaySnapshot {
    const gateway = this.singleGateway()
    return { service: gateway.snapshot(), acceptances: gateway.clientAcceptances(), attempts: gateway.clientAttempts(),
      desktop: gateway.codexDesktopRouteAcceptance(), ...(this.secondaryMissing ? { secondaryMissing: true } : {}) }
  }

  async stop(timeoutMs: number): Promise<void> {
    this.stopping = true
    await Promise.all([this.primary.drain(timeoutMs), this.secondary?.drain(timeoutMs)])
    await Promise.all([...this.transports.values()].map(transport => transport.deactivate().catch(() => undefined)))
    this.transports.clear()
    this.isolated.clear()
  }
}
