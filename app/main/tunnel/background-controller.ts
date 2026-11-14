import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiNetworkBinding } from '../../../sidecar/shared/api-network-continuation.mjs'
import type { NetworkAccountAccess } from './account-client'
import { acquireBackgroundNetworkController, guiNetworkControllerPresent } from './controller-seat'
import { readCurrentInfo } from './import-meta'
import { layout } from './paths'
import { TunnelService, type TunnelServiceDeps } from './tunnel-service'

export interface BackgroundAccount { readonly access: NetworkAccountAccess; readonly expiresAt: number }
export interface BackgroundControllerOptions {
  readonly dataDir: string
  readonly router: Omit<ApiNetworkBinding, 'bridgePort'>
  readonly loadAccount: () => Promise<BackgroundAccount | undefined>
  readonly serviceDeps: () => TunnelServiceDeps
  readonly onFailure?: () => void
}

/** The existing API router manages failover only after the GUI has really relinquished its seat. */
export class BackgroundNetworkController {
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  private stopped = false
  private active?: { service: TunnelService; release: () => void; ready: Promise<unknown>; account: BackgroundAccount; refreshing: boolean }
  private nextAccountCheck = 0
  private nextConfigurationCheck = 0

  constructor(private readonly options: BackgroundControllerOptions) {}

  start(): void {
    this.timer ??= setInterval(() => { void this.poll() }, 1_000)
    this.timer.unref?.()
  }

  poll(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = this.check().catch(() => this.options.onFailure?.()).finally(() => { this.pending = undefined })
    return this.pending
  }

  private binding(): ApiNetworkBinding | undefined {
    try {
      const intent = JSON.parse(readFileSync(layout.intent(this.options.dataDir), 'utf8')) as {
        desired?: string; apiOnly?: ApiNetworkBinding; authorization?: { expiresAt?: number }
      }
      const binding = intent.apiOnly, router = this.options.router
      if (intent.desired !== 'connected' || !binding || binding.pid !== router.pid || binding.bootId !== router.bootId ||
          binding.port !== router.port || binding.identitySecret !== router.identitySecret ||
          !Number.isInteger(binding.bridgePort) || binding.bridgePort < 1 || binding.bridgePort > 65535 ||
          typeof intent.authorization?.expiresAt !== 'number' || intent.authorization.expiresAt <= Date.now()) return undefined
      return binding
    } catch { return undefined }
  }

  private async detach(resumeForGui = false): Promise<void> {
    const active = this.active
    if (!active) return
    this.active = undefined
    try { await active.service.releaseBackgroundControl({ resumeForGui }); await active.ready }
    finally { active.release() }
  }

  private refreshConfiguration(): void {
    const active = this.active
    if (!active || active.refreshing || Date.now() < this.nextConfigurationCheck) return
    this.nextConfigurationCheck = Date.now() + 30_000
    active.refreshing = true
    active.ready = active.service.syncAccountConfig().catch(() => this.options.onFailure?.())
      .finally(() => { active.refreshing = false })
  }

  private async check(): Promise<void> {
    const guiPresent = guiNetworkControllerPresent(this.options.dataDir)
    if (this.stopped || guiPresent) { await this.detach(guiPresent && !this.stopped); return }
    if (existsSync(join(this.options.dataDir, 'account-signed-out'))) {
      if (this.active) await this.active.service.stop()
      await this.detach(); return
    }
    if (this.active && !this.active.service.backgroundControlCurrent()) { await this.detach(); return }
    if (this.active && Date.now() < this.nextAccountCheck && this.active.account.expiresAt > Date.now()) return
    const binding = this.active ? undefined : this.binding()
    if (!this.active && !binding) return
    const account = await this.options.loadAccount()
    const guiAfterRead = guiNetworkControllerPresent(this.options.dataDir)
    if (this.stopped || guiAfterRead) { await this.detach(guiAfterRead && !this.stopped); return }
    if (!account || account.expiresAt <= Date.now() ||
        readCurrentInfo(this.options.dataDir)?.accountId !== account.access.session.accountId) { await this.detach(); return }
    this.nextAccountCheck = Date.now() + 5_000
    if (this.active) {
      const previous = this.active.account.access
      if (previous.session.accessToken === account.access.session.accessToken &&
          previous.session.accountId === account.access.session.accountId && previous.client.sameEndpoint(account.access.client)) {
        this.active.account = account
        this.refreshConfiguration()
        return
      }
      await this.detach()
    }
    const freshBinding = this.binding()
    if (!freshBinding) return
    const release = acquireBackgroundNetworkController(this.options.dataDir)
    if (!release) return
    let service: TunnelService | undefined
    try {
      service = new TunnelService({ ...this.options.serviceDeps(), backgroundContinuation: { binding: freshBinding,
        isCurrent: () => this.active !== undefined && this.active.service === service && this.active.account.expiresAt > Date.now() &&
          !this.stopped && !guiNetworkControllerPresent(this.options.dataDir) } })
      const active = { service, release, account, ready: Promise.resolve() as Promise<unknown>, refreshing: true }
      this.active = active
      this.nextConfigurationCheck = Date.now() + 30_000
      active.ready = service.setAccountAccess(account.access).catch(() => this.options.onFailure?.())
        .finally(() => { active.refreshing = false })
    } catch (error) { release(); throw error }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.detach()
    await this.pending
  }
}
