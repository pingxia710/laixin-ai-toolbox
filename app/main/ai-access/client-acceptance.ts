import type { ApiShell, ModelProviderId } from '../../shared/api-service-types'

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
}

export interface ClientRouteAcceptance {
  readonly shell: ApiShell
  readonly provider: ModelProviderId
  readonly model: string
  readonly revision: string
  readonly at: string
}

export class ClientAcceptanceTracker {
  private active = new Map<ApiShell, ClientAcceptanceRoute>()
  private accepted = new Map<ApiShell, ClientRouteAcceptance>()

  replaceRoutes(routes: readonly ClientAcceptanceRoute[]): void {
    const next = new Map<ApiShell, ClientAcceptanceRoute>()
    for (const route of routes) next.set(route.shell, route)
    this.active = next
    for (const [shell, acceptance] of this.accepted) {
      if (next.get(shell)?.revision !== acceptance.revision) this.accepted.delete(shell)
    }
  }

  record(route: ClientAcceptanceRoute, at: string): boolean {
    const active = this.active.get(route.shell)
    if (!active || !sameRouteRevision(active, route)) return false
    if (!this.accepted.has(route.shell)) {
      this.accepted.set(route.shell, {
        shell: route.shell, provider: route.provider, model: route.model, revision: route.revision, at
      })
    }
    return true
  }

  acceptances(): Readonly<Partial<Record<ApiShell, ClientRouteAcceptance>>> {
    return Object.fromEntries(this.accepted) as Partial<Record<ApiShell, ClientRouteAcceptance>>
  }

  invalidate(shell: ApiShell): void { this.accepted.delete(shell) }

  clear(): void {
    this.active.clear()
    this.accepted.clear()
  }
}

function sameRouteRevision(left: ClientAcceptanceRoute, right: ClientAcceptanceRoute): boolean {
  // Claude Code may make a valid request with its configured small/subagent model. The revision binds the
  // provider, endpoint and local connection; model is recorded as observed metadata rather than a second route.
  return left.revision === right.revision && left.provider === right.provider && left.endpoint === right.endpoint
}
