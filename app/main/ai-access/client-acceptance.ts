import type { ApiFailure, ApiShell, ModelProviderId } from '../../shared/api-service-types'

/**
 * A route revision is generated whenever a shell's effective upstream binding changes.
 * Only a successful client request that carries that exact revision can establish that
 * the customer is currently using the selected API.
 */
export interface ClientAcceptanceRoute {
  readonly shell: ApiShell
  readonly provider: ModelProviderId
  readonly model: string
  readonly endpoint: string
  readonly revision: string
  /** Multi-model Codex routes are independently tracked by their stable internal model ID. */
  readonly routeId?: string
}

export interface ClientRouteAcceptance {
  readonly shell: ApiShell
  readonly provider: ModelProviderId
  readonly model: string
  readonly revision: string
  readonly at: string
  readonly lastAt: string
  readonly routeId?: string
}

/** 当前路由版本上最近一次已落定的客户端请求；不含请求内容。 */
export interface ClientRouteAttempt {
  readonly shell: ApiShell
  readonly provider: ModelProviderId
  readonly revision: string
  readonly at: string
  readonly ok: boolean
  readonly code?: ApiFailure
  readonly routeId?: string
}

export class ClientAcceptanceTracker {
  private active = new Map<string, ClientAcceptanceRoute>()
  private accepted = new Map<string, ClientRouteAcceptance>()
  private attempts = new Map<string, ClientRouteAttempt>()

  replaceRoutes(routes: readonly ClientAcceptanceRoute[]): void {
    const next = new Map<string, ClientAcceptanceRoute>()
    for (const route of routes) next.set(routeKey(route), route)
    this.active = next
    for (const [key, acceptance] of this.accepted) {
      if (next.get(key)?.revision !== acceptance.revision) this.accepted.delete(key)
    }
    for (const [key, attempt] of this.attempts) {
      if (next.get(key)?.revision !== attempt.revision) this.attempts.delete(key)
    }
  }

  record(route: ClientAcceptanceRoute, at: string): boolean {
    const key = routeKey(route)
    const active = this.active.get(key)
    if (!active || !sameRouteRevision(active, route)) return false
    const accepted = this.accepted.get(key)
    if (!accepted) {
      this.accepted.set(key, {
        shell: route.shell, provider: route.provider, model: route.model, revision: route.revision, at, lastAt: at,
        ...(route.routeId === undefined ? {} : { routeId: route.routeId })
      })
    } else if (Date.parse(at) > Date.parse(accepted.lastAt)) {
      // Keep first acceptance and previously read snapshots intact; only fresh success moves forward.
      this.accepted.set(key, { ...accepted, lastAt: at })
    }
    return true
  }

  recordAttempt(route: ClientAcceptanceRoute, at: string, ok: boolean, code?: ApiFailure): boolean {
    const key = routeKey(route)
    const active = this.active.get(key)
    if (!active || !sameRouteRevision(active, route)) return false
    const previous = this.attempts.get(key)
    if (!previous || Date.parse(at) >= Date.parse(previous.at)) {
      this.attempts.set(key, {
        shell: route.shell, provider: route.provider, revision: route.revision, at, ok,
        ...(code === undefined ? {} : { code }), ...(route.routeId === undefined ? {} : { routeId: route.routeId })
      })
    }
    return true
  }

  acceptances(): Readonly<Partial<Record<ApiShell, ClientRouteAcceptance>>> {
    return Object.fromEntries([...this.accepted].filter(([, value]) => value.routeId === undefined)) as Partial<Record<ApiShell, ClientRouteAcceptance>>
  }

  latestAttempts(): Readonly<Partial<Record<ApiShell, ClientRouteAttempt>>> {
    return Object.fromEntries([...this.attempts].filter(([, value]) => value.routeId === undefined)) as Partial<Record<ApiShell, ClientRouteAttempt>>
  }

  multiModelAcceptances(): Readonly<Record<string, ClientRouteAcceptance>> {
    return Object.fromEntries([...this.accepted].flatMap(([, value]) => value.routeId === undefined ? [] : [[value.routeId, value]]))
  }

  multiModelAttempts(): Readonly<Record<string, ClientRouteAttempt>> {
    return Object.fromEntries([...this.attempts].flatMap(([, value]) => value.routeId === undefined ? [] : [[value.routeId, value]]))
  }

  invalidate(shell: ApiShell): void {
    this.accepted.delete(shell)
    this.attempts.delete(shell)
  }

  clear(): void {
    this.active.clear()
    this.accepted.clear()
    this.attempts.clear()
  }
}

function sameRouteRevision(left: ClientAcceptanceRoute, right: ClientAcceptanceRoute): boolean {
  // Claude Code may make a valid request with its configured small/subagent model. The revision binds the
  // provider, endpoint and local connection; model is recorded as observed metadata rather than a second route.
  return left.revision === right.revision && left.provider === right.provider && left.endpoint === right.endpoint && left.routeId === right.routeId
}

function routeKey(route: ClientAcceptanceRoute): string { return route.routeId === undefined ? route.shell : `multi:${route.routeId}` }
