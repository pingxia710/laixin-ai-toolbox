import {
  NetworkAvailabilityController,
  type AvailabilityIntent,
  type AvailabilityOperation
} from '../../../sidecar/shared/network-availability-controller.mjs'

/** An integration opts into this capability explicitly; it is never inferred from an OS process. */
export type ApplicationIsolationApplication = 'codex' | 'claude' | 'hermes'
export type ApplicationIsolationScope = 'model-api-egress'
export type ApplicationIsolationCapability = 'http-connect'
export type ApplicationIsolationPhase = 'idle' | 'configuring' | 'verifying' | 'available' | 'restoring' | 'restored' | 'limited'
export type ApplicationIsolationAction = 'idle' | 'enable' | 'disable' | 'recover' | 'health'
export type ApplicationIsolationCode =
  | 'AVAILABLE'
  | 'RESTORED'
  | 'EXTERNAL_VALUE_PRESERVED'
  | 'ENTRY_UNAVAILABLE'
  | 'CONFIG_PATH_UNKNOWN'
  | 'CONFIG_WRITE_FAILED'
  | 'CONFIG_READBACK_MISMATCH'
  | 'TARGET_UNREACHABLE'
  | 'SYSTEM_NETWORK_CHANGED'
  | 'RESTORE_FAILED'
  | 'STALE_OPERATION'

/**
 * Public capability-lease state for an application integration. It contains no process identity,
 * local proxy address, target URL, configuration text or credential material. A successful
 * `available` state means a model API target was actually verified through the HTTP/CONNECT entry.
 */
export interface ApplicationIsolationLeaseStatus {
  readonly application: ApplicationIsolationApplication
  readonly scope: ApplicationIsolationScope
  readonly capability: ApplicationIsolationCapability
  readonly mode: 'application-only' | 'disabled'
  readonly systemNetwork: 'unmanaged'
  readonly phase: ApplicationIsolationPhase
  readonly action: ApplicationIsolationAction
  readonly intentGeneration: number
  readonly available: boolean
  readonly code: ApplicationIsolationCode
}

/** Opaque identities only. URLs, ports, configuration bodies and credentials never leave the main process. */
export interface ApplicationIsolationConfiguration {
  readonly id: string
  /** Opaque identity of the current provider/key/model target; never a URL or diagnostic field. */
  readonly targetIdentity: string
  /** Semantic configuration identity used by N-55's operation snapshot. */
  readonly fingerprint: string
  /** Exact owned-block identity, including customer comments; never exposed outside the main process. */
  readonly isolationFingerprint: string
}

/** Main-process endpoint capability that a later application integration may consume without OS-process detection. */
export interface ApplicationIsolationEntry {
  readonly capability: ApplicationIsolationCapability
  readonly id: string
  /** Main-process-only loopback endpoint. It never appears in status or diagnostics. */
  readonly proxyUrl: string
}
/** A main-process source may expose a fresh, N-55-proven local HTTP/CONNECT capability to an explicit application binding. */
export type ApplicationIsolationEntryReader = () => Promise<ApplicationIsolationEntry | undefined>

export type ApplicationIsolationRestoreResult = 'restored' | 'preserved-external'

export interface ApplicationIsolationAdapter {
  /** Returns only the verified application target identity and an opaque owned-section fingerprint. */
  inspect(): Promise<ApplicationIsolationConfiguration | undefined>
  /** Captures the controlled application section; the returned restore must preserve later external changes. */
  capture(): Promise<{
    readonly beforeFingerprint: string
    readonly beforeIsolationFingerprint: string
    readonly targetIdentity: string
    readonly leaseId: string
    readonly restoreIfOwned: () => Promise<ApplicationIsolationRestoreResult>
    /** Optional capture-bound settlement for targets that can change before the operation finishes. */
    readonly clearLease?: () => Promise<void>
  }>
  /** Binds only this integration's owned application surface to the verified local entry; never system networking. */
  activateEntry(entry: ApplicationIsolationEntry): Promise<void>
  /** Clears this integration's owned application surface after a failed/disabled lease; never changes system networking. */
  deactivateEntry(): Promise<void>
  /** Writes only the previously inspected, Toolbox-owned application configuration surface. */
  /** `stale` means the configuration changed after capture and was deliberately not written. */
  apply(): Promise<'applied' | 'stale' | void>
  /** Reads the controlled section after writing; a successful write is never enough. */
  readback(): Promise<boolean>
  /** Uses the isolated model API route to make the real target verification request. */
  verifyTarget(): Promise<boolean>
  /** Startup recovery of a persisted lease; it never recreates an entry. */
  recoverLease?(): Promise<'none' | ApplicationIsolationRestoreResult>
  /** Discards a settled lease record after restoration or third-party preservation. */
  clearLease?(leaseId: string): Promise<void>
}

/**
 * A digest of the system proxy/PAC/DNS/default-route observation. The isolation controller has no
 * system-write capability; this read-only before/after guard turns any unexpected drift into a
 * failed, restored operation instead of silently accepting it.
 */
export interface ApplicationIsolationSystemGuard {
  snapshot(): Promise<string>
}

interface ActiveIsolation {
  readonly intent: AvailabilityIntent
  readonly operation: AvailabilityOperation
  readonly restore: () => Promise<ApplicationIsolationRestoreResult>
  readonly leaseId: string
  /** Captured-target settlement takes precedence over the legacy current-target fallback. */
  readonly clearLease?: () => Promise<void>
  restoreResult?: ApplicationIsolationRestoreResult | 'failed'
}

export interface ApplicationIsolationLeaseControllerOptions {
  /** Explicit supported application binding; this is never inferred from an OS process. */
  readonly applicationId: ApplicationIsolationApplication
  readonly adapter: ApplicationIsolationAdapter
  readonly system: ApplicationIsolationSystemGuard
  /** Undefined means N-55 has no fresh, owned local-entry path evidence. */
  readonly entry: ApplicationIsolationEntryReader
}

/**
 * Owns no system networking. It applies the N-55 intent/identity/snapshot/lease/readback
 * contract to an explicit application's owned configuration surface, then accepts it only when
 * the application's model API target verification succeeds through the isolated HTTP/CONNECT entry.
 */
export class ApplicationIsolationLeaseController {
  private readonly availability = new NetworkAvailabilityController()
  private pending: Promise<void> = Promise.resolve()
  private nextIntent = 0
  private intentGeneration = 0
  private action: ApplicationIsolationAction = 'idle'
  private desired = false
  private active: ActiveIsolation | undefined
  private value: ApplicationIsolationLeaseStatus

  constructor(private readonly options: ApplicationIsolationLeaseControllerOptions) {
    this.value = this.disabled('idle', 'RESTORED')
  }

  status(): ApplicationIsolationLeaseStatus { return this.value }

  /** Test-only bounded-state observation; production diagnostics never expose this internal map. */
  debugOperationCount(): number {
    return (this.availability as unknown as { operations: Map<string, AvailabilityOperation> }).operations.size
  }

  enable(): Promise<ApplicationIsolationLeaseStatus> {
    const alreadyDesired = this.desired
    this.desired = true
    if (alreadyDesired && this.value.available && this.active !== undefined) return this.serialize(async () => this.value)
    const intent = this.beginIntent('enable')
    return this.serialize(() => this.enableCurrent(intent))
  }

  disable(): Promise<ApplicationIsolationLeaseStatus> {
    this.desired = false
    this.beginIntent('disable')
    return this.serialize(async () => {
      if (this.active === undefined) {
        // A failed restore can leave the owned configuration lease or private transport uncertain.
        // A second disable must not relabel that state as restored and authorize a later write.
        if (this.value.code === 'RESTORE_FAILED') return this.value
        if (this.value.phase !== 'restored') this.value = this.disabled('restored', 'RESTORED')
        return this.value
      }
      this.value = this.disabled('restoring', 'RESTORED')
      const restored = await this.restore(this.active)
      this.active = undefined
      if (restored === 'failed') return this.limit('RESTORE_FAILED')
      this.value = this.disabled('restored', restored === 'preserved-external' ? 'EXTERNAL_VALUE_PRESERVED' : 'RESTORED')
      return this.value
    })
  }

  /** Startup/crash recovery is deliberately idempotent and never recreates a route by itself. */
  recover(): Promise<ApplicationIsolationLeaseStatus> {
    this.desired = false
    this.beginIntent('recover')
    return this.serialize(async () => {
      if (this.active === undefined) {
        const retryingFailure = this.value.code === 'RESTORE_FAILED'
        if (retryingFailure && this.options.adapter.recoverLease === undefined) return this.value
        const recovered = await this.options.adapter.recoverLease?.().catch(() => 'failed')
        if (recovered === 'failed') return this.limit('RESTORE_FAILED')
        // The former lease may be settled while private-entry cleanup is still failing.
        if (retryingFailure) {
          try { await this.options.adapter.deactivateEntry() } catch { return this.limit('RESTORE_FAILED') }
        }
        this.value = this.disabled('restored', recovered === 'preserved-external' ? 'EXTERNAL_VALUE_PRESERVED' : 'RESTORED')
        return this.value
      }
      this.value = this.disabled('restoring', 'RESTORED')
      const restored = await this.restore(this.active)
      this.active = undefined
      if (restored === 'failed') return this.limit('RESTORE_FAILED')
      this.value = this.disabled('restored', restored === 'preserved-external' ? 'EXTERNAL_VALUE_PRESERVED' : 'RESTORED')
      return this.value
    })
  }

  /** Health checks are bounded reads: no configuration rewrite, no application restart and no retained operation. */
  reverify(): Promise<ApplicationIsolationLeaseStatus> {
    return this.serialize(async () => {
      if (this.value.phase !== 'available' || this.active === undefined) return this.value
      const active = this.active
      const generation = this.intentGeneration
      this.action = 'health'
      this.value = { ...this.value, action: this.action }
      const readback = await this.options.adapter.readback().catch(() => false)
      if (generation !== this.intentGeneration || this.active !== active) return this.value
      if (!readback) return this.reverifyFailed(active, generation, 'CONFIG_READBACK_MISMATCH')
      const reachable = await this.options.adapter.verifyTarget().catch(() => false)
      if (generation !== this.intentGeneration || this.active !== active) return this.value
      if (reachable) return this.value
      return this.reverifyFailed(active, generation, 'TARGET_UNREACHABLE')
    })
  }

  private async reverifyFailed(active: ActiveIsolation, generation: number, code: Extract<ApplicationIsolationCode, 'CONFIG_READBACK_MISMATCH' | 'TARGET_UNREACHABLE'>): Promise<ApplicationIsolationLeaseStatus> {
    this.value = { ...this.value, phase: 'restoring', available: false }
    const restored = await this.restore(active)
    if (generation !== this.intentGeneration || this.active !== active) return this.value
    this.active = undefined
    this.value = restored === 'failed' ? this.limit('RESTORE_FAILED')
      : restored === 'preserved-external' ? this.disabled('restored', 'EXTERNAL_VALUE_PRESERVED') : this.limit(code)
    return this.value
  }

  private beginIntent(action: string): AvailabilityIntent {
    const intent = this.availability.beginIntent({ id: `${this.options.applicationId}-isolation-${action}-${String(++this.nextIntent)}` })
    this.intentGeneration = intent.generation
    this.action = action as ApplicationIsolationAction
    this.value = { ...this.value, action: this.action, intentGeneration: this.intentGeneration }
    return intent
  }

  private async enableCurrent(intent: AvailabilityIntent): Promise<ApplicationIsolationLeaseStatus> {
    const beforeSystem = await this.options.system.snapshot().catch(() => undefined)
    if (beforeSystem === undefined) return this.limit('SYSTEM_NETWORK_CHANGED')
    const entry = await this.options.entry().catch(() => undefined)
    if (entry === undefined) return this.limit('ENTRY_UNAVAILABLE')
    if (entry.capability !== 'http-connect') return this.limit('ENTRY_UNAVAILABLE')
    const configuration = await this.options.adapter.inspect().catch(() => undefined)
    if (configuration === undefined) return this.limit('CONFIG_PATH_UNKNOWN')
    const captured = await this.options.adapter.capture().catch(() => undefined)
    if (captured === undefined) return this.limit('CONFIG_PATH_UNKNOWN')
    if (captured.beforeFingerprint !== configuration.fingerprint || captured.beforeIsolationFingerprint !== configuration.isolationFingerprint || captured.targetIdentity !== configuration.targetIdentity) {
      return this.discardUnstartedLease(captured.leaseId, 'STALE_OPERATION', captured.clearLease)
    }

    const started = this.availability.start({
      intent,
      action: 'takeover',
      conflict: { id: configuration.id, kind: 'application-configuration' },
      path: { id: entry.id, target: configuration.targetIdentity },
      snapshot: { id: `application-config:${this.options.applicationId}:${configuration.id}`, value: configuration.fingerprint },
      lease: { id: `laixin-app-isolation:${this.options.applicationId}:${configuration.id}`, owner: 'laixin', expiresAt: Date.now() + 60_000 }
    })
    if (started.blocked === true) return this.discardUnstartedLease(captured.leaseId, 'STALE_OPERATION', captured.clearLease)
    const operation = started
    const active: ActiveIsolation = { intent, operation, restore: captured.restoreIfOwned, leaseId: captured.leaseId, clearLease: captured.clearLease }
    this.active = active
    if (!this.availability.isCurrent(operation)) return this.stale(active)

    this.value = this.state('application-only', 'configuring', false, 'AVAILABLE')
    try { await this.options.adapter.activateEntry(entry) } catch { return this.failed(active, 'ENTRY_UNAVAILABLE') }
    try { if (await this.options.adapter.apply() === 'stale') return this.stale(active) } catch { return this.failed(active, 'CONFIG_WRITE_FAILED') }
    if (!this.availability.isCurrent(operation)) return this.stale(active)
    if (!this.availability.markWritten(operation)) return this.stale(active)

    const readback = await this.options.adapter.readback().catch(() => false)
    if (!this.availability.isCurrent(operation)) return this.stale(active)
    if (!readback) return this.failed(active, 'CONFIG_READBACK_MISMATCH')
    this.value = { ...this.value, phase: 'verifying' }
    const targetReachable = await this.options.adapter.verifyTarget().catch(() => false)
    if (!this.availability.isCurrent(operation)) return this.stale(active)
    if (!targetReachable) return this.failed(active, 'TARGET_UNREACHABLE')
    if (!await this.options.adapter.readback().catch(() => false)) return this.failed(active, 'CONFIG_READBACK_MISMATCH')
    if (beforeSystem !== await this.options.system.snapshot().catch(() => undefined)) return this.failed(active, 'SYSTEM_NETWORK_CHANGED')

    const completed = this.availability.complete(operation, { readbackMatches: true, targetReachable: true, conflict: operation.conflict, path: operation.path })
    if (!completed.ok) return this.stale(active)
    this.value = this.state('application-only', 'available', true, 'AVAILABLE')
    return this.value
  }

  private async failed(active: ActiveIsolation, code: Exclude<ApplicationIsolationCode, 'AVAILABLE' | 'RESTORED' | 'EXTERNAL_VALUE_PRESERVED' | 'RESTORE_FAILED' | 'STALE_OPERATION'>): Promise<ApplicationIsolationLeaseStatus> {
    if (!this.isCurrent(active)) {
      const restored = await this.restore(active)
      return this.staleResult(restored)
    }
    const restored = await this.restore(active)
    const currentAfterRestore = this.isCurrent(active)
    if (this.active === active) this.active = undefined
    this.availability.fail(active.operation, code)
    if (!currentAfterRestore) return this.staleResult(restored)
    this.value = restored === 'failed' ? this.limit('RESTORE_FAILED')
      : restored === 'preserved-external' ? this.disabled('restored', 'EXTERNAL_VALUE_PRESERVED') : this.limit(code)
    return this.value
  }

  private async stale(active: ActiveIsolation): Promise<ApplicationIsolationLeaseStatus> {
    const currentBeforeRestore = this.isCurrent(active)
    const restored = await this.restore(active)
    const currentAfterRestore = this.isCurrent(active)
    if (currentBeforeRestore && currentAfterRestore) {
      if (this.active === active) this.active = undefined
      this.availability.fail(active.operation, 'STALE_OPERATION')
      this.value = restored === 'failed' ? this.limit('RESTORE_FAILED')
        : restored === 'preserved-external' ? this.disabled('restored', 'EXTERNAL_VALUE_PRESERVED') : this.limit('STALE_OPERATION')
      return this.value
    }
    return this.staleResult(restored)
  }

  private async restore(active: ActiveIsolation): Promise<ApplicationIsolationRestoreResult | 'failed'> {
    if (active.restoreResult !== undefined) return active.restoreResult
    let configurationResult: ApplicationIsolationRestoreResult | 'failed' = 'failed'
    try { configurationResult = await active.restore() } catch { /* The private entry must still be cleared below. */ }
    let result = configurationResult
    try { await this.options.adapter.deactivateEntry() } catch { result = 'failed' }
    if (configurationResult !== 'failed') {
      try {
        if (active.clearLease !== undefined) await active.clearLease()
        else await this.options.adapter.clearLease?.(active.leaseId)
      } catch { result = 'failed' }
    }
    active.restoreResult = result
    return result
  }

  private async discardUnstartedLease(leaseId: string, code: ApplicationIsolationCode, clearLease?: () => Promise<void>): Promise<ApplicationIsolationLeaseStatus> {
    try {
      if (clearLease !== undefined) await clearLease()
      else await this.options.adapter.clearLease?.(leaseId)
    } catch { return this.limit('RESTORE_FAILED') }
    return this.limit(code)
  }

  private isCurrent(active: ActiveIsolation): boolean { return this.active === active && this.availability.isCurrent(active.operation) }
  private staleResult(restored: ApplicationIsolationRestoreResult | 'failed'): ApplicationIsolationLeaseStatus {
    // A newer intent may have left `value` configuring/verifying. Returning a stale result with
    // that phase plus STALE_OPERATION would violate the public status contract and make IPC fail
    // closed for the wrong reason. Do not overwrite the newer intent's stored state.
    return this.state('application-only', 'limited', false, restored === 'failed' ? 'RESTORE_FAILED' : 'STALE_OPERATION')
  }
  private limit(code: ApplicationIsolationCode): ApplicationIsolationLeaseStatus { this.value = this.unavailable(code); return this.value }
  private state(mode: 'application-only' | 'disabled', phase: ApplicationIsolationPhase, available: boolean, code: ApplicationIsolationCode): ApplicationIsolationLeaseStatus {
    return { application: this.options.applicationId, scope: 'model-api-egress', capability: 'http-connect', mode, systemNetwork: 'unmanaged', phase, action: this.action, intentGeneration: this.intentGeneration, available, code }
  }
  private unavailable(code: ApplicationIsolationCode): ApplicationIsolationLeaseStatus { return this.state('application-only', 'limited', false, code) }
  private disabled(phase: Extract<ApplicationIsolationPhase, 'idle' | 'restoring' | 'restored'>, code: Extract<ApplicationIsolationCode, 'RESTORED' | 'EXTERNAL_VALUE_PRESERVED'>): ApplicationIsolationLeaseStatus { return this.state('disabled', phase, false, code) }
  private serialize<T>(task: () => Promise<T>): Promise<T> { const result = this.pending.then(task); this.pending = result.then(() => undefined, () => undefined); return result }
}
