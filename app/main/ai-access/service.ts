import { randomBytes } from 'node:crypto'
import {
  isProviderModelAllowed,
  isProviderShellSupported,
  isStoredProviderModelAllowed,
  modelProviderIds,
  modelProviders,
  normalizeProviderModel,
  providerShellContract,
  type ApiServiceConnection
} from '../../shared/model-providers'
import { apiFailureMessage, apiFailureRemedy, apiRemedyLabels, type AccessRecovery, type ApiCheck, type ApiFailure, type ApiLatency, type ApiRemedyAction, type ApiRemedyResult, type ApiServiceSnapshot, type ApiUsageStage, type ConfigurationState } from '../../shared/api-service-types'
import type { FaultInput } from '../diagnostics/fault-log'
import type { FaultNoteId } from '../../shared/fault-log-types'
import type { ModelMatrixEntry, ModelMatrixProgress, ModelMatrixReport } from '../../shared/model-matrix-types'
import type { AiGateway, GatewayRoute } from './gateway'
import type { ConfigurationTargetEvidence } from './configuration-target'
import type { CodexOfficialAuthStatus } from './codex-auth-document'
import { configWriteFaultNotice } from './config-write-fault'
import { isPortListening, residualAddressNote, residualLoopbackAddress } from './residual-address'
import type { UsageReceiptEvent } from './usage-receipt'

/** 核对结果：按壳的一致性判定，可能带上客户可读的说明（比如别的工具留下的死地址）。 */
export type ConfigurationVerification = Readonly<Record<AiAccessShell, ConfigurationState>> & {
  /** 一条都没有时不带这个键，⛔ 让老调用方看到空对象之外的意外结构。 */
  readonly notes?: readonly string[]
}

export const aiAccessShells = ['codex', 'claude', 'hermes'] as const
export type AiAccessShell = typeof aiAccessShells[number]

const softwareNames: Readonly<Record<AiAccessShell, string>> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }

export const aiAccessProviders = modelProviderIds
export type AiAccessProvider = typeof aiAccessProviders[number]
export const aiAccessModes = [...aiAccessProviders, 'official', 'zai'] as const
export type AiAccessMode = typeof aiAccessModes[number]
export type ExplicitConfigurationTargetScope = 'user' | 'project'

export interface AiAccessState {
  readonly version: 1
  readonly shellKeys?: Readonly<Partial<Record<AiAccessShell, Readonly<Partial<Record<AiAccessProvider, string>>>>>>
  readonly shellModels?: Readonly<Partial<Record<AiAccessShell, Readonly<Partial<Record<AiAccessProvider, string>>>>>>
  readonly deepseekKey?: string
  readonly zaiKey?: string
  readonly zhipuKey?: string
  readonly kimiKey?: string
  readonly moonshotKey?: string
  readonly relay?: { readonly port: number; readonly token: string }
  readonly relayShells?: readonly AiAccessShell[]
  /** Written before touching shell files; unfinished changes remain blocked after restart. */
  readonly pendingShells?: readonly AiAccessShell[]
  /** 写配置成功时记下的托管段指纹，用来发现之后被别的工具改动；⛔ 存配置原文。 */
  readonly shellFingerprints?: Readonly<Partial<Record<AiAccessShell, string>>>
  /** Claude 客户明确确认过的配置作用域；Codex 永远使用用户级配置。 */
  readonly configurationTargetScopes?: Readonly<Partial<Record<AiAccessShell, ExplicitConfigurationTargetScope>>>
  readonly selected: Readonly<Partial<Record<AiAccessShell, AiAccessMode>>>
}

export interface AiAccessStateStore {
  read(): Promise<AiAccessState>
  write(state: AiAccessState): Promise<void>
  /** 损坏隔离后的一次性提示;无提示返回 undefined(与 read 的空状态配套)。 */
  consumeCorruptionNote?: () => string | undefined
  /** 写失败分译(Phase 2 ⑤)的一句话:磁盘满/权限/通用各一译,一次性,status() 取走后清空。 */
  consumeWriteFaultNote?: () => string | undefined
}

export interface AiAccessAdapter {
  readonly shell: AiAccessShell
  applyDeepSeek(key: string): Promise<void>
  applyProvider?(provider: Exclude<AiAccessProvider, 'deepseek'>, key: string): Promise<void>
  applyConnection?(provider: AiAccessProvider, connection: ApiServiceConnection): Promise<void>
  captureConnection?(): Promise<() => Promise<void>>
  /** 当前这个壳里工具箱托管段的指纹；没有托管段返回 undefined。读不出就让上层报「不能判断」。 */
  readManagedFingerprint?(): Promise<string | undefined>
  /** No raw local path, command arguments, or environment content may leave this method. */
  configurationTargetStatus?(): Promise<ConfigurationTargetEvidence>
  /** A project target becomes writable only after this explicit customer-facing selection. */
  selectConfigurationTarget?(scope: ExplicitConfigurationTargetScope): Promise<ConfigurationTargetEvidence>
  /** Main-process-only directory selection; the path never reaches state or renderer. */
  selectConfigurationProject?(projectDir: string): Promise<ConfigurationTargetEvidence>
  /** Remove only the Toolbox binding. Restoring a historical connection is a separate action. */
  deactivateToolboxConnection?(): Promise<void>
  /** Explicit recovery only. It may restore a previous third-party configuration such as CC Switch. */
  restorePreviousConnection?(): Promise<void>
  /** Whether a trusted pre-connection recovery point exists right now; drives the visible recovery entry. */
  recoveryPointStatus?(): Promise<boolean>
  /** 客户当前配置里的接口地址（只有 URL，没有 Key）。接管前的残留死地址核对用；读不出返回 undefined。 */
  readCurrentBaseUrl?(): Promise<string | undefined>
  /** Safe structural result for Codex's official auth file; never exposes credential content. */
  officialAuthenticationStatus?(): Promise<CodexOfficialAuthStatus>
  /** Main-process-only effective Codex user root for the official-login child process. Never expose it through status or IPC. */
  codexOfficialLoginRoot?(): Promise<string>
  activateOfficial?: () => Promise<void>
}

export interface AiAccessStatus {
  readonly legacyZaiKeySaved?: boolean
  /** 保存的 Key 存储损坏被隔离后的一次性提示,界面照原文展示一句。 */
  readonly storageNote?: string
  readonly attempt?: ApiCheck
  /** Why an effective configuration cannot yet be auto-rewritten. Never contains a file path or arguments. */
  readonly configurationTargets?: Readonly<Partial<Record<AiAccessShell, ConfigurationTargetEvidence>>>
  /** Only a safe Codex credential classification; absence means no conclusion was available. */
  readonly officialAuthentication?: Readonly<Partial<Record<AiAccessShell, CodexOfficialAuthStatus>>>
  readonly shells: Readonly<Record<AiAccessShell, {
    readonly selected: AiAccessMode | null
    readonly officialAvailable: boolean
    readonly providerKeys: Readonly<Record<AiAccessProvider, boolean>>
    /** A historical route no longer has native-client evidence. It remains stored but is not live. */
    readonly suspended?: { readonly provider: AiAccessProvider; readonly reason: 'provider-pending-verification' }
    /** A supported route whose configuration update was interrupted. It is not current until explicitly re-applied. */
    readonly interrupted?: { readonly provider: AiAccessProvider; readonly reason: 'configuration-interrupted' }
    /** A pre-gateway direct configuration is retained as history, never represented as a live Toolbox route. */
    readonly legacyDirect?: { readonly provider: AiAccessProvider; readonly reason: 'not-managed-by-current-gateway' }
    /** Only when the adapter can judge it: a trusted pre-connection recovery point exists for explicit recovery. */
    readonly recoveryPointAvailable?: boolean
  }>>
}

const keyPattern = /^[A-Za-z0-9._-]{16,512}$/
type LegacyKeyField = 'deepseekKey' | 'zhipuKey' | 'kimiKey' | 'moonshotKey'
/** `zhipu-api` has no historical field: never reinterpret a Coding Plan Key as a metered API Key. */
const legacyKeyFields: Readonly<Record<AiAccessProvider, LegacyKeyField | undefined>> = {
  deepseek: 'deepseekKey',
  'zhipu-api': undefined,
  zhipu: 'zhipuKey',
  kimi: 'kimiKey',
  moonshot: 'moonshotKey'
}
const legacyKeyFieldNames: readonly LegacyKeyField[] = ['deepseekKey', 'zhipuKey', 'kimiKey', 'moonshotKey']

function isProvider(value: unknown): value is AiAccessProvider {
  return aiAccessProviders.includes(value as AiAccessProvider)
}

/** A saved choice can outlive native-client evidence. Keep it visible, but never route or rewrite it. */
function isSuspendedSelection(state: AiAccessState, shell: AiAccessShell): boolean {
  const provider = state.selected[shell]
  return isProvider(provider) && !isProviderShellSupported(provider, shell)
}

/**
 * Before the local gateway existed, a state could remember a selected provider and Key without
 * owning a relay route. Keep the material for an explicit migration, but do not call it current.
 */
function isLegacyDirectSelection(state: AiAccessState, shell: AiAccessShell): boolean {
  const provider = state.selected[shell]
  return isProvider(provider) && isProviderShellSupported(provider, shell) && !state.relayShells?.includes(shell) &&
    state.pendingShells?.includes(shell) !== true
}

function isInterruptedSelection(state: AiAccessState, shell: AiAccessShell): boolean {
  const provider = state.selected[shell]
  // A relayShell entry without relay credentials is a half-written historical state, not a
  // live local route. Keep the customer's selected provider and Key untouched, but surface it
  // as interrupted so recovery never claims that a nonexistent gateway can be restarted.
  return isProvider(provider) && (state.pendingShells?.includes(shell) === true ||
    (state.relay === undefined && state.relayShells?.includes(shell) === true))
}

function activeRelayKey(state: AiAccessState, shell: AiAccessShell): string | undefined {
  const provider = state.selected[shell]
  if (!isProvider(provider) || !isProviderShellSupported(provider, shell) || state.pendingShells?.includes(shell) === true ||
    state.relay === undefined || state.relayShells?.includes(shell) !== true) return undefined
  const key = state.shellKeys?.[shell]?.[provider]
  return typeof key === 'string' && keyPattern.test(key) ? key : undefined
}

/**
 * Keeps the customer's connection choice separate from each shell's config.
 * The state store is responsible for encrypting the key before it reaches disk.
 */
export interface AiAccessExtras {
  /** 版本闸门：返回说明文字即拦截，undefined 放行。 */
  readonly gate?: (shell: AiAccessShell, provider: AiAccessProvider) => Promise<string | undefined>
  /** 配方解析：允许后台下发的接口/模型覆盖内置值。 */
  readonly resolveRoute?: (shell: AiAccessShell, provider: AiAccessProvider) => { endpoint: string; model: string }
  /** 故障经过留痕；实现方负责清洗与容量，本服务只管报事实，⛔ 因记录失败影响主流程。 */
  readonly recordFault?: (fault: FaultInput) => void
  /**
   * Mac 使用回执（API-04）：五个固定阶段的结果出口，只带白名单字段；实现方负责 macOS 判定、
   * 校验、裁剪与落盘。记录失败由实现方吞掉，⛔ 影响配置、探测、调用、解除或恢复。
   */
  readonly recordUsageEvent?: (event: UsageReceiptEvent) => void
  /** 这个软件装没装；读不到就当没装，验证矩阵会标「跳过」而不是「失败」。 */
  readonly shellInstalled?: (shell: AiAccessShell) => Promise<boolean>
  /** 验证矩阵结果落盘（无 Key）。 */
  readonly saveMatrix?: (report: ModelMatrixReport) => Promise<void> | void
  /** 本机端口探测：残留死地址核对用，测试注入。默认真连 127.0.0.1。 */
  readonly isPortListening?: (port: number) => Promise<boolean>
}

export class AiAccessService {
  private readonly adapters: ReadonlyMap<AiAccessShell, AiAccessAdapter>
  private pending: Promise<void> = Promise.resolve()
  private checks: ApiCheck[] = []
  private attempt?: ApiCheck
  private startupError?: ApiFailure
  /** 配置写入并回读通过的时刻，按壳记；恢复官方或换渠道即作废。 */
  private configuredAt = new Map<AiAccessShell, { at: string; provider: AiAccessProvider }>()
  /** 最近一次配置一致性核对的结论，按壳记；serviceStatus 只报缓存，⛔ 每次轮询都去动壳。 */
  private configurations = new Map<AiAccessShell, ConfigurationState>()
  private configurationTargets = new Map<AiAccessShell, ConfigurationTargetEvidence>()
  private recoveryPoints = new Map<AiAccessShell, boolean>()
  private officialAuthentications = new Map<AiAccessShell, CodexOfficialAuthStatus>()
  private matrixProgress: ModelMatrixProgress = { done: 0, total: 0 }
  /** 上一条已经记过的持续故障原因；同一个原因一直不好，就 ⛔ 每次核对都再落一条。 */
  private lastFailure?: string
  /** The clients retry a failed request themselves; keep all request facts, but write one support fault per burst. */
  private recentClientFaults = new Map<string, number>()

  constructor(private readonly store: AiAccessStateStore, adapters: readonly AiAccessAdapter[], private readonly gateway?: AiGateway,
    private readonly extras: AiAccessExtras = {}) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.shell, adapter]))
    if (this.adapters.size !== aiAccessShells.length || aiAccessShells.some((shell) => !this.adapters.has(shell))) {
      throw new Error('AI_ACCESS_ADAPTERS_INVALID')
    }
    // 客户在 AI 里真正用起来之后才出现的故障（Key 被上游拒、厂商侧断线…）也要进故障记录，
    // 否则帮助页只剩「上次自测通过」，客服拿不到证据。⛔ 动 attempt——那是客户自己测过的事实。
    this.gateway?.onClientFailure(record => {
      const code = record.code ?? 'unknown'
      const now = Date.now()
      const signature = `${record.shell}|${record.provider}|${code}`
      for (const [key, at] of this.recentClientFaults) if (now - at >= 60_000) this.recentClientFaults.delete(key)
      const previous = this.recentClientFaults.get(signature)
      if (previous !== undefined && now - previous < 60_000) return
      this.recentClientFaults.set(signature, now)
      this.extras.recordFault?.({ shell: record.shell, provider: record.provider, code })
      this.extras.recordUsageEvent?.({ shell: record.shell, stage: 'client-call', outcome: 'failure', code, at: record.at })
    })
  }

  async status(): Promise<AiAccessStatus> {
    await this.pending
    const state = await this.read()
    // `read()` may quarantine a corrupt encrypted state and create this one-shot note. Consume it
    // afterwards so the first status response carries the customer-facing recovery instruction.
    // 写失败分译(Phase 2 ⑤)同用这个出口:磁盘满/权限那句话跟上一次状态读数,⛔ 只留在异常码里。
    const note = this.store.consumeCorruptionNote?.() ?? this.store.consumeWriteFaultNote?.()
    await this.refreshConfigurationTargets(state)
    await this.refreshOfficialAuthentication(state)
    await this.refreshRecoveryPoints()
    const view = this.publicStatus(state)
    return note ? { ...view, storageNote: note } : view
  }

  /** Safe target evidence for the page: it explains a blocked repair without leaking a local path or launch arguments. */
  async configurationTarget(shell: AiAccessShell): Promise<ConfigurationTargetEvidence | undefined> {
    await this.pending
    this.adapter(shell)
    await this.refreshConfigurationTarget(shell, await this.read())
    return this.configurationTargets.get(shell)
  }

  /**
   * Returns the already-validated Codex user root only to the main-process official-login flow.
   * It is deliberately not part of AiAccessStatus or a registered bridge action.
   */
  async codexOfficialLoginRoot(): Promise<string> {
    await this.pending
    const root = await this.adapter('codex').codexOfficialLoginRoot?.()
    if (root === undefined || root === '') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    return root
  }

  /** The UI uses this after the customer chooses the single understandable repair action for a detected project config. */
  async selectConfigurationTarget(shell: AiAccessShell, scope: ExplicitConfigurationTargetScope): Promise<AiAccessStatus> {
    return this.serialize(async () => {
      // Codex has no project-level provider-routing target. Its user configuration is selected
      // automatically, so no bridge/UI caller can turn a project diagnostic into a write target.
      if (shell === 'codex') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_UNSUPPORTED')
      const previous = await this.read()
      this.assertConfigurationTargetChangeIsSafe(previous, shell)
      const adapter = this.adapter(shell)
      if (adapter.selectConfigurationTarget === undefined) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_UNSUPPORTED')
      const evidence = await adapter.selectConfigurationTarget(scope)
      const next: AiAccessState = {
        ...previous,
        configurationTargetScopes: { ...previous.configurationTargetScopes, [shell]: scope }
      }
      await this.store.write(next)
      this.configurationTargets.set(shell, evidence)
      return this.publicStatus(next)
    })
  }

  /** A native directory chooser supplies the path to the adapter only; state and renderer retain just its safe evidence. */
  async selectConfigurationProject(shell: AiAccessShell, projectDir: string): Promise<AiAccessStatus> {
    return this.serialize(async () => {
      if (shell === 'codex') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_UNSUPPORTED')
      const previous = await this.read()
      this.assertConfigurationTargetChangeIsSafe(previous, shell)
      const adapter = this.adapter(shell)
      if (adapter.selectConfigurationProject === undefined) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_UNSUPPORTED')
      const evidence = await adapter.selectConfigurationProject(projectDir)
      if (evidence.shell !== shell || evidence.scope !== 'project' || !evidence.writable) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
      const next: AiAccessState = {
        ...previous,
        configurationTargetScopes: { ...previous.configurationTargetScopes, [shell]: 'project' }
      }
      await this.store.write(next)
      this.configurationTargets.set(shell, evidence)
      return this.publicStatus(next)
    })
  }

  /** Editor metadata only: resolve the same recipe as routing, without exposing the saved Key. */
  async providerConfiguration(shell: AiAccessShell, provider: AiAccessProvider): Promise<{ keyUrl: string; endpoint: string; model: string; models: string[] }> {
    await this.pending
    this.adapter(shell)
    if (!isProvider(provider)) throw new Error('AI_ACCESS_PROVIDER_INVALID')
    this.assertProviderShellSupported(shell, provider)
    const state = await this.read()
    const { endpoint, model } = this.route(shell, provider, '', state)
    return { keyUrl: modelProviders[provider].keyUrl, endpoint, model, models: this.modelChoices(shell, provider) }
  }

  /** An entered Key is transient: no persistence, shell writes, or provider switch. */
  async measureProviderLatency(shell: AiAccessShell, provider: AiAccessProvider, value: string, model = ''): Promise<ApiLatency> {
    await this.pending
    this.adapter(shell)
    if (!isProvider(provider)) throw new Error('AI_ACCESS_PROVIDER_INVALID')
    this.assertProviderShellSupported(shell, provider)
    const state = await this.read()
    this.validateModel(shell, provider, model)
    const key = value.trim() || state.shellKeys?.[shell]?.[provider]
    if (!key) return { ok: false, latencyMs: null, code: 'key_missing' }
    if (!keyPattern.test(key)) return { ok: false, latencyMs: null, code: 'key_rejected' }
    if (!this.gateway) return { ok: false, latencyMs: null, code: 'not_configured' }
    return this.gateway.measureLatency(this.route(shell, provider, key, state, model))
  }

  async saveProviderKey(shell: AiAccessShell, provider: AiAccessProvider, value: string): Promise<AiAccessStatus> {
    return this.serialize(async () => {
      this.adapter(shell)
      if (!isProvider(provider)) throw new Error('AI_ACCESS_PROVIDER_INVALID')
      this.assertProviderShellSupported(shell, provider)
      const key = value.trim()
      if (!keyPattern.test(key)) throw new Error(`AI_ACCESS_${provider.toUpperCase()}_KEY_INVALID`)
      const previous = await this.read()
      // An active route must never be pointed at an untested replacement Key. Reuse the same
      // probe/write transaction as the visible “保存并验证” action; until it passes, the
      // persisted state and gateway route still contain the previous working Key.
      if (previous.selected[shell] === provider) {
        const model = previous.shellModels?.[shell]?.[provider] ?? this.route(shell, provider, '', previous).model
        return this.activateProviderNow(shell, provider, { key, model })
      }
      const next: AiAccessState = { ...previous,
        shellKeys: { ...previous.shellKeys, [shell]: { ...previous.shellKeys?.[shell], [provider]: key } } }
      await this.store.write(next)
      this.attempt = undefined
      this.checks = this.checks.filter(check => check.shell !== shell || check.provider !== provider)
      this.updateRoutes(next)
      return this.publicStatus(next)
    })
  }

  async useProvider(shell: AiAccessShell, provider: AiAccessProvider): Promise<AiAccessStatus> {
    return this.activateProvider(shell, provider)
  }

  /**
   * API-06：快捷 Key 表单的唯一原子入口。候选 Key 先探测，探测、写入、配置任一步失败都
   * 回到原 Key、原模型、原路由，⛔ 未启用来源先把 Key 落盘再验证；模型内部沿用该来源
   * 已存选择（走 route() 的 已存→配方→默认 顺序），⛔ 表单把默认模型写死。
   */
  async useProviderWithKey(shell: AiAccessShell, provider: AiAccessProvider, key: string): Promise<AiAccessStatus> {
    return this.activateProvider(shell, provider, { key })
  }

  /** Editor save is atomic: validate the candidate Key/model before replacing the old binding. */
  async configureProvider(shell: AiAccessShell, provider: AiAccessProvider, key: string, model: string): Promise<AiAccessStatus> {
    if (!model) throw new Error('AI_ACCESS_MODEL_INVALID')
    return this.activateProvider(shell, provider, { key, model })
  }

  private async activateProvider(shell: AiAccessShell, provider: AiAccessProvider, input?: { key: string; model?: string }): Promise<AiAccessStatus> {
    return this.serialize(() => this.activateProviderNow(shell, provider, input))
  }

  /** Runs inside the service serialization queue so a candidate Key cannot race an active route change. */
  private async activateProviderNow(shell: AiAccessShell, provider: AiAccessProvider, input?: { key: string; model?: string }): Promise<AiAccessStatus> {
      if (!isProvider(provider)) throw new Error('AI_ACCESS_PROVIDER_INVALID')
      this.assertProviderShellSupported(shell, provider)
      const adapter = this.adapter(shell)
      let previous = await this.read()
      if (input && !this.gateway) throw new Error('AI_ACCESS_PROVIDER_UNSUPPORTED')
      this.validateModel(shell, provider, input?.model ?? '')
      try { await this.ensureConfigurationTarget(shell, previous) } catch (error) {
        this.markCheck(shell, provider, false, 'configuration_failed', this.configurationTargetNotice(shell) ?? await configWriteFaultNotice(error))
        return this.publicStatus(previous)
      }
      const key = input?.key.trim() || previous.shellKeys?.[shell]?.[provider]
      if (key === undefined) { this.recordUsage(shell, 'probe', 'unverified', 'key_missing'); throw new Error(`AI_ACCESS_${provider.toUpperCase()}_KEY_MISSING`) }
      if (!keyPattern.test(key)) { this.recordUsage(shell, 'probe', 'unverified', 'key_rejected'); throw new Error(`AI_ACCESS_${provider.toUpperCase()}_KEY_INVALID`) }
      const route = this.route(shell, provider, key, previous, input?.model)
      const blocked = await this.extras.gate?.(shell, provider)
      if (blocked) { this.recordUsage(shell, 'probe', 'unverified', 'shell_version_incompatible'); this.markCheck(shell, provider, false, 'shell_version_incompatible', blocked); return this.publicStatus(previous) }
      if (this.gateway) {
        try { previous = await this.ensureGateway(previous) } catch {
          this.recordUsage(shell, 'probe', 'unverified', 'port_unavailable')
          this.markCheck(shell, provider, false, 'port_unavailable')
          return this.publicStatus(previous)
        }
        const result = await this.gateway.probe(route)
        this.recordUsage(shell, 'probe', result.ok ? 'success' : 'failure', result.ok ? undefined : result.code ?? 'unknown')
        const suggestedProvider = result.ok ? undefined : await this.suggestedProviderForKey(shell, provider, key, previous, result.code)
        const code = suggestedProvider === undefined ? result.code : 'key_product_mismatch'
        this.markCheck(shell, provider, result.ok, code, suggestedProvider === undefined ? undefined : this.suggestedProviderNotice(provider, suggestedProvider), suggestedProvider)
        if (!result.ok) return this.publicStatus(previous)
      }
      let rollback: (() => Promise<void>) | undefined
      if (this.gateway) {
        try {
          if (!adapter.applyConnection || !adapter.captureConnection || !previous.relay || !this.gateway.baseUrl) throw new Error('AI_ACCESS_PROVIDER_UNSUPPORTED')
          rollback = await adapter.captureConnection()
          await this.beginChange(previous, shell)
        } catch {
          this.recordUsage(shell, 'config-write', 'failure', 'configuration_failed')
          this.markCheck(shell, provider, false, 'configuration_failed')
          return this.publicStatus(previous)
        }
      }
      try {
        if (this.gateway) {
          await adapter.applyConnection!(provider, { baseUrl: this.connectionUrl(shell, provider), apiKey: previous.relay!.token, model: route.model })
        } else if (provider === 'deepseek') await adapter.applyDeepSeek(key)
        else if (adapter.applyProvider !== undefined) await adapter.applyProvider(provider, key)
        else throw new Error('AI_ACCESS_PROVIDER_UNSUPPORTED')
      } catch (error) {
        if (this.gateway) {
          const code: ApiFailure = await this.rollbackChange(previous, rollback!) ? 'configuration_failed' : 'configuration_rollback_failed'
          this.recordUsage(shell, 'config-write', 'failure', code)
          this.markCheck(shell, provider, false, code, await configWriteFaultNotice(error))
          return this.publicStatus(previous)
        }
        if (error instanceof Error && error.message === 'AI_ACCESS_PROVIDER_UNSUPPORTED') throw error
        throw new Error('AI_ACCESS_APPLY_FAILED', { cause: error })
      }
      const next: AiAccessState = { ...previous, selected: { ...previous.selected, [shell]: provider },
        ...(input ? {
          shellKeys: { ...previous.shellKeys, [shell]: { ...previous.shellKeys?.[shell], [provider]: key } }
        } : {}),
        ...(input || previous.shellModels?.[shell]?.[provider] !== undefined && previous.shellModels?.[shell]?.[provider] !== route.model ? {
          shellModels: { ...previous.shellModels, [shell]: { ...previous.shellModels?.[shell], [provider]: route.model } }
        } : {}),
        ...(this.gateway ? { relayShells: [...new Set([...(previous.relayShells ?? []), shell])], pendingShells: previous.pendingShells?.filter(item => item !== shell) } : {}),
        shellFingerprints: await this.captureFingerprints(previous.shellFingerprints, [shell]) }
      try { await this.store.write(next) } catch (error) {
        if (!this.gateway) throw error
        const restored = await this.rollbackChange(previous, rollback!)
        this.recordUsage(shell, 'config-write', 'failure', restored ? 'configuration_failed' : 'configuration_rollback_failed')
        this.markCheck(shell, provider, false, restored ? 'configuration_failed' : 'configuration_rollback_failed', await configWriteFaultNotice(error))
        return this.publicStatus(previous)
      }
      this.updateRoutes(next)
      this.configuredAt.set(shell, { at: new Date().toISOString(), provider })
      this.configurations.set(shell, 'ok')
      this.recordUsage(shell, 'config-write', 'success')
      return this.publicStatus(next)
  }

  async useOfficial(shell: AiAccessShell): Promise<AiAccessStatus> {
    return this.serialize(async () => {
      const adapter = this.adapter(shell)
      const previous = await this.read()
      try { await this.ensureConfigurationTarget(shell, previous) } catch { throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED') }
      if (adapter.deactivateToolboxConnection === undefined && adapter.activateOfficial === undefined) throw new Error('AI_ACCESS_OFFICIAL_UNSUPPORTED')
      const rollback = await adapter.captureConnection?.()
      if (this.gateway) {
        if (!rollback) throw new Error('AI_ACCESS_APPLY_FAILED')
        await this.beginChange(previous, shell)
      }
      try {
        if (adapter.deactivateToolboxConnection !== undefined) await adapter.deactivateToolboxConnection()
        else await adapter.activateOfficial!()
      } catch {
        if (this.gateway) await this.rollbackChange(previous, rollback!)
        throw new Error('AI_ACCESS_APPLY_FAILED')
      }
      const next: AiAccessState = { ...previous, selected: { ...previous.selected, [shell]: 'official' }, relayShells: previous.relayShells?.filter(item => item !== shell), pendingShells: previous.pendingShells?.filter(item => item !== shell),
        shellFingerprints: withoutShell(previous.shellFingerprints, shell) }
      try { await this.store.write(next) } catch {
        if (this.gateway) await this.rollbackChange(previous, rollback!)
        else if (rollback) await rollback()
        throw new Error('AI_ACCESS_APPLY_FAILED')
      }
      this.attempt = undefined
      this.configuredAt.delete(shell)
      this.configurations.set(shell, 'not-managed')
      this.updateRoutes(next)
      await this.refreshOfficialAuthentication(next)
      await this.refreshRecoveryPoints()
      return this.publicStatus(next)
    })
  }

  /**
   * This is deliberately separate from useOfficial(): a saved pre-Toolbox backup can belong to CC Switch or
   * another third-party route. The caller explicitly asks to restore that prior connection and the status never
   * labels it as official.
   */
  async restorePreviousConnection(shell: AiAccessShell): Promise<AiAccessStatus> {
    return this.serialize(async () => {
      const previous = await this.read()
      // 旧恢复点可能来自 CC Switch 等第三方路由。只有先明确解除工具箱路由、处于官方状态，
      // 才允许这个显式恢复动作；⛔ 靠界面隐藏按钮来保护直接 bridge 调用。
      if (previous.selected[shell] !== 'official') throw new Error('AI_ACCESS_RESTORE_PREVIOUS_REQUIRES_OFFICIAL')
      const adapter = this.adapter(shell)
      if (adapter.restorePreviousConnection === undefined) throw new Error('AI_ACCESS_RESTORE_PREVIOUS_UNSUPPORTED')
      await this.ensureConfigurationTarget(shell, previous)
      const rollback = await adapter.captureConnection?.()
      if (this.gateway) {
        if (!rollback) throw new Error('AI_ACCESS_APPLY_FAILED')
        await this.beginChange(previous, shell)
      }
      try { await adapter.restorePreviousConnection() } catch {
        if (this.gateway) await this.rollbackChange(previous, rollback!)
        throw new Error('AI_ACCESS_APPLY_FAILED')
      }
      const selected = Object.fromEntries(Object.entries(previous.selected).filter(([name]) => name !== shell)) as AiAccessState['selected']
      const next: AiAccessState = {
        ...previous,
        selected,
        relayShells: previous.relayShells?.filter(item => item !== shell),
        pendingShells: previous.pendingShells?.filter(item => item !== shell),
        shellFingerprints: withoutShell(previous.shellFingerprints, shell)
      }
      try { await this.store.write(next) } catch {
        if (this.gateway) await this.rollbackChange(previous, rollback!)
        else if (rollback) await rollback()
        throw new Error('AI_ACCESS_APPLY_FAILED')
      }
      this.attempt = undefined
      this.configuredAt.delete(shell)
      this.configurations.set(shell, 'not-managed')
      this.officialAuthentications.delete(shell)
      this.updateRoutes(next)
      await this.refreshRecoveryPoints()
      return this.publicStatus(next)
    })
  }

  /** Only restarts previously configured toolbox routes; never rewrites a shell on startup. */
  async initialize(): Promise<void> {
    await this.serialize(async () => {
      try {
        const state = await this.read()
        if (state.relay) {
          try { await this.ensureGateway(state) } catch { this.startupError = 'port_unavailable' }
        } else this.updateRoutes(state)
      } catch { this.startupError = 'configuration_failed' }
    })
  }

  async serviceStatus(): Promise<ApiServiceSnapshot> {
    await this.pending
    const state = await this.read().catch(() => undefined)
    const base = this.gateway?.snapshot() ?? { running: false, baseUrl: null, startedAt: null, requests: [], routes: [] }
    // 配置已经指向本机服务，服务却没在跑：这是本机故障，⛔ 混进「服务商异常」。
    const liveRelayShells = state === undefined ? [] : aiAccessShells.filter(shell => activeRelayKey(state, shell) !== undefined)
    const down = this.gateway !== undefined && !base.running && liveRelayShells.length > 0
    const suspended = state !== undefined && aiAccessShells.some(shell => isSuspendedSelection(state, shell))
    // A paused row is local information. It becomes a global interruption only when there is no
    // active route at all; an active Claude/Hermes route must not inherit a pending Codex fault.
    const pendingBlocksAllRoutes = liveRelayShells.length === 0 &&
      ((state?.pendingShells?.length ?? 0) > 0 || suspended ||
        (state !== undefined && aiAccessShells.some(shell => isInterruptedSelection(state, shell)))
      )
    const retainedStartupError = this.startupError
    const startupError = down
      ? 'local_service_down'
      : retainedStartupError ?? (pendingBlocksAllRoutes ? 'configuration_interrupted' : undefined)
    return { ...base, ...(startupError ? { startupError } : {}), checks: [...this.checks], usage: this.usageStages(state) }
  }

  /** 「测过 / 写了 / 真的在用」三件分开报；判不出就是 null，⛔ 用「配置写了」冒充「在用」。 */
  private usageStages(state?: AiAccessState): readonly ApiUsageStage[] {
    const observed = this.gateway?.clientAcceptances() ?? {}
    return aiAccessShells.map(shell => {
      const selected = state?.selected[shell]
      // 还没切换过的壳，按客户刚测过的那一家报进度；已切到官方就没有第三方进度可报。
      const provider = state !== undefined && isProvider(selected) && !isLegacyDirectSelection(state, shell) &&
        !isSuspendedSelection(state, shell) && !isInterruptedSelection(state, shell) ? selected
        : selected === undefined ? this.checks.find(check => check.shell === shell)?.provider ?? null : null
      const configured = this.configuredAt.get(shell)
      const configuration = state !== undefined && (isSuspendedSelection(state, shell) || isInterruptedSelection(state, shell))
        ? 'unknown'
        : state?.relayShells?.includes(shell) && provider ? this.configurations.get(shell) ?? 'unknown' : 'not-managed'
      const currentConfiguration = configuration === 'ok'
      const codexDesktopRoute = shell === 'codex' && provider !== null && currentConfiguration
        ? this.gateway?.codexDesktopRouteAcceptance() ?? { status: 'unverified' as const, at: null, reason: 'socket_binding_unavailable' as const }
        : undefined
      return {
        shell,
        provider,
        tested: provider ? this.checks.find(check => check.shell === shell && check.provider === provider && check.ok)?.at ?? null : null,
        configured: provider && configured?.provider === provider ? configured.at : null,
        // AiGateway only retains acceptances whose revision still matches the active route. A late call on the
        // old provider therefore cannot turn the newly selected provider into "in use".
        observedClientCall: provider && currentConfiguration && observed[shell]?.provider === provider ? observed[shell]!.at : null,
        lastObservedClientCall: provider && currentConfiguration && observed[shell]?.provider === provider ? observed[shell]!.lastAt : null,
        ...(codexDesktopRoute === undefined ? {} : { codexDesktopRoute }),
        configuration
      }
    })
  }

  async testProvider(shell: AiAccessShell, provider: AiAccessProvider): Promise<ApiServiceSnapshot> {
    await this.serialize(async () => {
      this.adapter(shell)
      if (!isProvider(provider)) throw new Error('AI_ACCESS_PROVIDER_INVALID')
      this.assertProviderShellSupported(shell, provider)
      const state = await this.read()
      const key = state.shellKeys?.[shell]?.[provider]
      if (!key) { this.recordUsage(shell, 'probe', 'unverified', 'key_missing'); this.markCheck(shell, provider, false, 'key_missing'); return }
      const blocked = await this.extras.gate?.(shell, provider)
      if (blocked) { this.recordUsage(shell, 'probe', 'unverified', 'shell_version_incompatible'); this.markCheck(shell, provider, false, 'shell_version_incompatible', blocked); return }
      if (!this.gateway) { this.recordUsage(shell, 'probe', 'unverified', 'not_configured'); this.markCheck(shell, provider, false, 'not_configured'); return }
      try { await this.ensureGateway(state) } catch {
        this.recordUsage(shell, 'probe', 'unverified', 'port_unavailable')
        this.markCheck(shell, provider, false, 'port_unavailable'); return
      }
      const result = await this.gateway.probe(this.route(shell, provider, key, state))
      this.recordUsage(shell, 'probe', result.ok ? 'success' : 'failure', result.ok ? undefined : result.code ?? 'unknown')
      const suggestedProvider = result.ok ? undefined : await this.suggestedProviderForKey(shell, provider, key, state, result.code)
      const code = suggestedProvider === undefined ? result.code : 'key_product_mismatch'
      // 取消的检查给与计费提示一致的交代，⛔ 让面板把它当「连不上服务商」。
      const notice = code === 'client_aborted' ? '接口测试已取消；已发出的请求可能仍按服务商规则计费。'
        : suggestedProvider === undefined ? undefined : this.suggestedProviderNotice(provider, suggestedProvider)
      this.markCheck(shell, provider, result.ok, code, notice, suggestedProvider)
    })
    return this.serviceStatus()
  }

  /**
   * 统一处理动作：做完一定复验，能证明好了才说好了。
   * 复验不通过就报当前判类和下一步建议，⛔ 把「命令执行完」当修好。
   */
  async remedy(shell: AiAccessShell, action: Exclude<ApiRemedyAction, 'openConsole'>, intended?: AiAccessProvider): Promise<ApiRemedyResult> {
    await this.pending
    this.adapter(shell)
    // 界面上的按钮是为**刚才失败的那一次**出的，就得对着那家服务商办事。
    // 第一次启用就失败时 selected 还停在 null/官方，只看 selected 会让「打开控制台」「重新写入配置」全落空。
    const provider = intended ?? await this.currentProvider(shell)
    // 记下动作前的那条记录：复验只认换成新对象的结果，⛔ 拿旧的成功记录当「已恢复」。
    const before = this.checks.find(item => item.shell === shell && item.provider === provider)
    if (action === 'useOfficial') {
      let status: AiAccessStatus
      try { status = await this.useOfficial(shell) } catch {
        return this.remedyResult(shell, provider, action, 'still_failing', 'configuration_failed', '没能恢复官方配置，原配置保持不变。请检查磁盘与文件权限后重试。')
      }
      const authentication = status.officialAuthentication?.[shell]
      if (authentication?.state === 'login-required') {
        return this.remedyResult(shell, null, action, 'unknown', undefined, '工具箱 API 路由已解除，但当前没有可确认的官方登录。请在 Codex 中完成官方登录后再试。')
      }
      return this.remedyResult(shell, null, action, 'unknown', undefined, '工具箱 API 路由已解除。请在这个 AI 里试一次官方登录。')
    }
    if (action === 'restartGateway') {
      const failure = await this.restartGateway()
      if (failure === 'port_unavailable') {
        // 记住的端口被占用：照原端口重启永远不会成功——占用程序不退，点多少次都一样。
        // 直接走恢复流程换端口重绑：令牌一并轮换、能核对的壳回写新地址，这条自愈链是现成的（⛔ 放弃式处理）。
        const recovery = await this.recoverAccess('manual')
        if (recovery.outcome === 'repaired' || recovery.outcome === 'ok') {
          return this.remedyResult(shell, provider, action, 'recovered', undefined,
            `记住的本机端口被别的程序占用，已换到新端口重新起来${recovery.rewroteShells?.length ? '，并把配置改到了新地址' : ''}；重新测试通过，现在可以用了。`)
        }
        return this.remedyResult(shell, provider, action, 'still_failing', recovery.code ?? 'port_unavailable',
          `重启没有成功：原来的端口被占用，自动换端口也没能完成。${recovery.message}`)
      }
      if (failure) return this.remedyResult(shell, provider, action, 'still_failing', failure, `重启本机 API 服务没有成功：${apiFailureMessage(failure, provider ?? undefined)}`)
      if (!provider) return this.remedyResult(shell, null, action, 'unknown', undefined, '本机 API 服务已重启。这个 AI 目前没有使用工具箱的模型 API，请直接在软件里试一次。')
    }
    if (!provider) return this.remedyResult(shell, null, action, 'unknown', 'not_configured', apiFailureMessage('not_configured'))
    if (action === 'reapply') {
      try { await this.activateProvider(shell, provider) } catch { /* 失败原因已记进 checks，下面统一按复验结果回答。 */ }
    } else await this.testProvider(shell, provider)
    const latest = this.checks.find(item => item.shell === shell && item.provider === provider)
    const check = latest === before ? undefined : latest
    if (check?.ok) return this.remedyResult(shell, provider, action, 'recovered', undefined, `${apiRemedyLabels[action]}后重新测试通过，现在可以用了。`)
    if (!check) return this.remedyResult(shell, provider, action, 'unknown', 'unknown', `${apiRemedyLabels[action]}做完了，但这次没能复验出结果，请再试一次。`)
    const code = check.code ?? 'unknown'
    return this.remedyResult(shell, provider, action, 'still_failing', code,
      `${apiRemedyLabels[action]}后仍然不通：${apiFailureMessage(code, provider)}${check.notice ? ` ${check.notice}` : ''}`)
  }

  private async currentProvider(shell: AiAccessShell): Promise<AiAccessProvider | null> {
    const state = await this.read().catch(() => undefined)
    const selected = state?.selected[shell]
    return isProvider(selected) ? selected : null
  }

  /**
   * 三壳 × 四来源 × 候选模型的真实验证矩阵：每格跑一次现有的完整探测（回复 + 工具调用 + 流式）。
   * 串行跑，每格靠网关自带的超时兜底——**一个模型卡住 ⛔ 拖死整张表**。
   * 只读状态、只打上游：⛔ 写壳配置、⛔ 改客户已选模型、⛔ 创建本机路由。
   */
  async probeMatrix(onProgress?: (progress: ModelMatrixProgress) => void): Promise<ModelMatrixReport> {
    await this.pending
    const state = await this.read()
    const plan: { shell: AiAccessShell; provider: AiAccessProvider; models: readonly string[] }[] = []
    for (const provider of aiAccessProviders) {
      for (const shell of aiAccessShells) {
        if (isProviderShellSupported(provider, shell)) plan.push({ shell, provider, models: this.modelChoices(shell, provider) })
      }
    }
    const total = plan.reduce((sum, item) => sum + (state.shellKeys?.[item.shell]?.[item.provider] ? item.models.length : 1), 0)
    const entries: ModelMatrixEntry[] = []
    const installed = new Map<AiAccessShell, boolean>()
    const report = (done: number, current: ModelMatrixProgress['current']): void => {
      this.matrixProgress = { done, total, ...(current ? { current } : {}) }
      onProgress?.(this.matrixProgress)
    }
    const note = (entry: ModelMatrixEntry): void => {
      entries.push(entry)
      report(entries.length, { provider: entry.provider, shell: entry.shell, model: entry.model })
    }
    report(0, undefined)
    for (const { shell, provider, models } of plan) {
      const at = () => new Date().toISOString()
      const key = state.shellKeys?.[shell]?.[provider]
      const fallback = models[0] ?? ''
      if (!key) { note({ provider, shell, model: fallback, state: 'skipped', skipped: 'key_missing', at: at() }); continue }
      if (!installed.has(shell)) {
        installed.set(shell, this.extras.shellInstalled === undefined ? true : await this.extras.shellInstalled(shell).catch(() => false))
      }
      if (!installed.get(shell)) { note({ provider, shell, model: fallback, state: 'skipped', skipped: 'shell_missing', at: at() }); continue }
      const blocked = await this.extras.gate?.(shell, provider).catch(() => undefined)
      if (blocked) { note({ provider, shell, model: fallback, state: 'skipped', skipped: 'version_gate', at: at() }); continue }
      for (const model of models) {
        if (!this.gateway) { note({ provider, shell, model, state: 'skipped', skipped: 'shell_missing', at: at() }); continue }
        // 先报「正在测哪一格」：48 格串行跑下来，运维要看得见进度而不是干等。
        report(entries.length, { provider, shell, model })
        let result: { ok: boolean; code?: ApiFailure; firstTextMs?: number }
        try { result = await this.gateway.probe(this.route(shell, provider, key, state, model)) } catch { result = { ok: false, code: 'unknown' } }
        note({ provider, shell, model, state: result.ok ? 'passed' : 'failed',
          ...(result.ok ? {} : { code: result.code ?? 'unknown' }),
          ...(result.firstTextMs === undefined ? {} : { firstTextMs: result.firstTextMs }), at: at() })
      }
    }
    const result: ModelMatrixReport = { at: new Date().toISOString(), entries }
    this.matrixProgress = { done: entries.length, total }
    await this.extras.saveMatrix?.(result)
    return result
  }

  /** 矩阵跑到哪了；桥上没有推送通道，由调用方轮询。 */
  matrixStatus(): ModelMatrixProgress { return this.matrixProgress }

  /**
   * 配置一致性核对：配置写进去之后，可能被 CC Switch / Cockpit 之类工具改掉，
   * 也可能被人手工删掉。这里比对托管段指纹，**只报告、⛔ 自动覆盖客户的改动**。
   * 接管前的核对同时认出「别的工具留下的死地址」并把话说全（点名端口、说清来历）。
   */
  async verifyConfigurations(): Promise<ConfigurationVerification> {
    // 进串行队列(Phase 2 ⑥):切换/恢复写到一半时并发核对,会把工具箱自己的改写看成
    // 「被外部改动」,还顺手作废刚攒下的客户端验收证据。排在队尾等写完再核,⛔ 半路上读指纹。
    return this.serialize(async () => {
      const state = await this.read().catch(() => undefined)
      const record = await this.inspectConfigurations(state)
      const notes = await this.residualAddressNotes()
      return notes.length === 0 ? record : { ...record, notes }
    })
  }

  /** 只报告：哪个壳的接口地址指着没人听的端口（= 别的工具留下的死配置）。⛔ 改接管行为。 */
  private async residualAddressNotes(): Promise<readonly string[]> {
    const notes: string[] = []
    const probe = this.extras.isPortListening ?? isPortListening
    for (const shell of aiAccessShells) {
      const read = this.adapter(shell).readCurrentBaseUrl
      if (read === undefined) continue
      const url = await read().catch(() => undefined)
      const address = residualLoopbackAddress(url)
      if (address === null) continue
      // 探测失败按「有人在听」处理：宁可不吭声，⛔ 冤枉一个活配置。
      if (await probe(address.port).catch(() => true)) continue
      notes.push(residualAddressNote(softwareNames[shell], address))
    }
    return notes
  }

  /**
   * 重开 / 唤醒 / 断网恢复后核对接入：本机服务在不在跑、端口是不是记的那个、配置还是不是我们写的那份。
   * 端口被占就换一个可用端口并把三壳配置回写到新地址，**已选模型保持不变**。
   */
  async recoverAccess(reason: AccessRecovery['reason']): Promise<AccessRecovery> {
    return this.serialize(async () => {
      const at = new Date().toISOString()
      const initial = await this.read().catch(() => undefined)
      if (!initial) return this.recovery(reason, at, 'still_failing', 'configuration_failed', '读不到本机保存的接入状态，无法核对。', undefined, [], 'recovery_state_unavailable')
      // Only a current, keyed and non-pending relay can be rebound. An old pending row may keep
      // a relayShells entry, but it must never be restarted or rewritten as collateral damage.
      const routed = aiAccessShells.filter(shell => activeRelayKey(initial, shell) !== undefined)
      // A release can revoke an old route after its native-client evidence is superseded. Keep
      // that customer's state and shell file untouched, but make the suspended route explicit.
      const suspended = aiAccessShells.filter(shell => isSuspendedSelection(initial, shell))
      // A pending historical selection is not a recoverable live route, even if an older state
      // did not persist relayShells. Do not start/rebind a gateway or touch shell files here.
      const interrupted = aiAccessShells.filter(shell => isInterruptedSelection(initial, shell))
      if ((suspended.length > 0 || interrupted.length > 0) && routed.length === 0) {
        const paused = [...new Set([...suspended, ...interrupted])]
        // This branch never restarts or rewrites a paused shell, but it may read its managed
        // fingerprint. A later missing/externally changed file is new diagnostic information and
        // must not be collapsed into the original "write was interrupted" fault forever.
        const configurations = await this.inspectConfigurations(initial)
        const broken = paused.filter(shell => configurations[shell] === 'modified-externally' || configurations[shell] === 'missing')
        if (broken.length > 0) {
          return this.recovery(reason, at, 'still_failing', 'configuration_failed',
            `${broken.map(shell => shellLabel(shell)).join('、')} 的配置已不是工具箱写的那份，请重新写入配置。`,
            configurations, [], 'recovery_config_broken')
        }
        return this.recovery(reason, at, 'still_failing', 'configuration_interrupted',
          `${paused.map(shell => shellLabel(shell)).join('、')} 当前路由已暂停，工具箱不会自动改写。请选择已验收入口或解除工具箱接管。`,
          configurations, [], 'recovery_config_broken')
      }
      if (!this.gateway || !initial.relay || (routed.length === 0 && suspended.length === 0)) {
        return this.recovery(reason, at, 'not-managed', undefined, '当前没有 AI 在使用工具箱的模型 API，无需恢复。', this.inspectStates(initial))
      }
      let state = initial
      let relay = initial.relay
      let rebound = false
      const port = this.gateway.baseUrl === null ? null : Number(new URL(this.gateway.baseUrl).port)
      if (port !== relay.port || !this.gatewayRunning()) {
        await this.gateway.stop()
        try {
          await this.gateway.start(relay.port, relay.token)
        } catch {
          // 记的端口被别的程序占了：换一个可用端口，⛔ 让三壳继续把请求发给占用者。
          // 旧端口现在归那个陌生程序，而壳里的配置还带着本机中继令牌；换端口时一并轮换令牌，
          // 拿到旧令牌的程序就打不开新端口。⛔ 沿用旧令牌。
          const rotated = randomBytes(32).toString('hex')
          let replacement: number
          try { replacement = await this.gateway.start(0, rotated) } catch {
            this.updateRoutes(state)
            return this.recovery(reason, at, 'still_failing', 'local_service_down', apiFailureMessage('local_service_down'), await this.inspectConfigurations(state), [], 'recovery_service_down')
          }
          relay = { port: replacement, token: rotated }
          state = { ...state, relay }
          rebound = true
        }
        this.updateRoutes(state)
      }
      const rewrote: AiAccessShell[] = []
      if (rebound) {
        // 回写是拿新端口把托管段整段重渲染，客户在块内改过的行会被覆盖。所以先核对这一段还是不是
        // 工具箱写的那份：被别的程序改过、不见了、读不出来的壳一律跳过，留在暂停态交「重新写入配置」，
        // ⛔ 顺手把客户的改动盖掉。
        const before = await this.inspectConfigurations(state)
        const writable = routed.filter(shell => before[shell] === 'ok')
        const pending: AiAccessState = { ...state, pendingShells: [...new Set([...(state.pendingShells ?? []), ...routed])] }
        try { await this.store.write(pending) } catch {
          // The new listener/token are not durable until this write succeeds.  Pause routes before
          // returning and stop that listener so a stale UI/state cannot leave a usable route alive.
          this.updateRoutes(pending)
          await this.gateway.stop().catch(() => undefined)
          return this.recovery(reason, at, 'still_failing', 'configuration_failed', '换用新端口后没能记录改动标记，已暂停对应路由。', await this.inspectConfigurations(state), [], 'recovery_state_unavailable')
        }
        this.updateRoutes(pending)
        for (const shell of writable) {
          const provider = state.selected[shell]
          if (!isProvider(provider)) continue
          const adapter = this.adapter(shell)
          try {
            if (adapter.applyConnection === undefined) throw new Error('AI_ACCESS_PROVIDER_UNSUPPORTED')
            await adapter.applyConnection(provider, { baseUrl: this.connectionUrl(shell, provider), apiKey: relay.token, model: this.route(shell, provider, '', state).model })
            rewrote.push(shell)
            this.configuredAt.set(shell, { at, provider })
          } catch { /* 这个壳没改成就继续暂停，其余照改，⛔ 一个失败拖垮全部。 */ }
        }
        state = { ...state, pendingShells: (pending.pendingShells ?? []).filter(shell => !rewrote.includes(shell)),
          shellFingerprints: await this.captureFingerprints(state.shellFingerprints, rewrote) }
        try { await this.store.write(state) } catch {
          return this.recovery(reason, at, 'still_failing', 'configuration_failed', '新端口的配置写进去了，但没能保存状态，请重新启用这个 AI。', await this.inspectConfigurations(state), [], 'recovery_state_unavailable')
        }
        this.updateRoutes(state)
      }
      const configurations = await this.inspectConfigurations(state)
      const broken = routed.filter(shell => configurations[shell] === 'modified-externally' || configurations[shell] === 'missing')
      if (broken.length > 0) {
        return this.recovery(reason, at, 'still_failing', 'configuration_failed',
          `${broken.map(shell => shellLabel(shell)).join('、')} 的配置已不是工具箱写的那份，请重新写入配置。`, configurations, rewrote, 'recovery_config_broken')
      }
      if (!this.gatewayRunning()) {
        return this.recovery(reason, at, 'still_failing', 'local_service_down', apiFailureMessage('local_service_down'), configurations, rewrote, 'recovery_service_down')
      }
      // 报「已恢复 / 正常」要四件事同时成立：服务在跑、配置能确认、上次改动做完了、网关里真有这条路由。
      // 少一件，客户端打过来就是 409——路由还是断的，⛔ 说成好了。
      const live = new Set(this.gateway.snapshot().routes.map(route => route.shell))
      const unresolved = routed.filter(shell => configurations[shell] === 'unknown' || state.pendingShells?.includes(shell) === true || !live.has(shell))
      if (unresolved.length > 0) {
        return this.recovery(reason, at, 'still_failing', 'configuration_interrupted',
          `${unresolved.map(shell => shellLabel(shell)).join('、')} 的配置这次没能落定，对应路由保持暂停，请重新写入配置。`, configurations, rewrote, 'recovery_config_broken')
      }
      const moved = rewrote.map(shell => shellLabel(shell)).join('、')
      return rebound
        ? this.recovery(reason, at, 'repaired', undefined, `本机 API 服务原来的端口被占用，已换到 ${String(relay.port)}${moved ? ` 并把${moved}的配置改到新地址` : ''}，模型选择不变。`, configurations, rewrote, 'recovery_port_changed', [String(relay.port)])
        : this.recovery(reason, at, 'ok', undefined, '本机 API 服务在跑，端口与各 AI 的配置都对得上。', configurations, rewrote)
    })
  }

  private recovery(reason: AccessRecovery['reason'], at: string, outcome: AccessRecovery['outcome'], code: ApiFailure | undefined,
    message: string, configurations?: Readonly<Record<AiAccessShell, ConfigurationState>>, rewrote: readonly AiAccessShell[] = [],
    note?: FaultNoteId, noteParams?: readonly string[]): AccessRecovery {
    const result: AccessRecovery = { reason, at, outcome, ...(code ? { code } : {}), message,
      ...(rewrote.length ? { rewroteShells: [...rewrote] } : {}),
      configurations: configurations ?? this.cachedConfigurations() }
    if (outcome === 'still_failing' || outcome === 'repaired') {
      // 定时核对每 10 分钟一次：一个没人管的故障一天能落 144 条一模一样的记录，把「最近故障」挤成一色，
      // 客服反而看不到别的。所以持续的故障只在「从好变坏」或「原因变了」时记一条，好了就清、再坏再记。
      // repaired 是一次性事件（真的换了端口），照旧每次都记。
      const signature = outcome === 'still_failing' ? [code, note, ...(noteParams ?? [])].join('|') : undefined
      if (signature === undefined || signature !== this.lastFailure) {
        this.extras.recordFault?.({ ...(code ? { code } : {}), action: outcome === 'repaired' ? 'restartGateway' : undefined,
          outcome: outcome === 'repaired' ? 'recovered' : 'still_failing', ...(note ? { note } : {}), ...(noteParams ? { noteParams } : {}) })
      }
      this.lastFailure = signature
    } else this.lastFailure = undefined
    return result
  }

  private gatewayRunning(): boolean { return this.gateway?.snapshot().running === true }

  /** 读当前托管段指纹；读不出就让该壳报「不能判断」，⛔ 猜成没被改。 */
  private async captureFingerprints(previous: AiAccessState['shellFingerprints'], shells: readonly AiAccessShell[]): Promise<AiAccessState['shellFingerprints']> {
    let next: AiAccessState['shellFingerprints'] = previous
    for (const shell of shells) {
      const read = this.adapter(shell).readManagedFingerprint
      if (read === undefined) continue
      try {
        const print = await read()
        next = print === undefined ? withoutShell(next, shell) : { ...next, [shell]: print }
      } catch { next = withoutShell(next, shell) }
    }
    return next && Object.keys(next).length ? next : undefined
  }

  private async inspectConfigurations(state?: AiAccessState): Promise<Readonly<Record<AiAccessShell, ConfigurationState>>> {
    const entries = await Promise.all(aiAccessShells.map(async shell => {
      const provider = state?.selected[shell]
      if (!state || !isProvider(provider)) return [shell, 'not-managed'] as const
      // A stale route that is no longer in the product contract is deliberately paused. It may
      // still have an old local managed block, but that cannot be shown as a usable configuration.
      if (!isProviderShellSupported(provider, shell)) return [shell, 'unknown'] as const
      if (!state.relayShells?.includes(shell)) return [shell, 'not-managed'] as const
      const expected = state.shellFingerprints?.[shell]
      const read = this.adapter(shell).readManagedFingerprint
      if (expected === undefined || read === undefined) return [shell, 'unknown'] as const
      let actual: string | undefined
      try { actual = await read() } catch { return [shell, 'unknown'] as const }
      if (actual === undefined) return [shell, 'missing'] as const
      return [shell, actual === expected ? 'ok' : 'modified-externally'] as const
    }))
    for (const [shell, verdict] of entries) {
      const before = this.configurations.get(shell)
      this.configurations.set(shell, verdict)
      // The native config no longer points to the route we wrote. Never let an older successful
      // request or a Desktop socket proof reappear after a later recheck says otherwise.
      if (verdict !== 'ok' && before !== verdict) this.gateway?.invalidateClientAcceptance?.(shell)
      // 只在「从好变坏」时留一条，⛔ 每次核对都写一条把记录刷满。
      if (before !== verdict && (verdict === 'modified-externally' || verdict === 'missing')) {
        const provider = state?.selected[shell]
        this.extras.recordFault?.({ shell, ...(isProvider(provider) ? { provider } : {}), code: 'configuration_failed',
          note: verdict === 'modified-externally' ? 'configuration_modified' : 'configuration_missing' })
      }
    }
    return Object.fromEntries(entries) as Record<AiAccessShell, ConfigurationState>
  }

  private async refreshConfigurationTargets(state: AiAccessState): Promise<void> {
    await Promise.all(aiAccessShells.map(shell => this.refreshConfigurationTarget(shell, state)))
  }

  private async refreshConfigurationTarget(shell: AiAccessShell, state: AiAccessState): Promise<ConfigurationTargetEvidence | undefined> {
    const adapter = this.adapter(shell)
    if (adapter.configurationTargetStatus === undefined) {
      this.configurationTargets.delete(shell)
      return undefined
    }
    try {
      const selectedScope = shell === 'codex' ? undefined : state.configurationTargetScopes?.[shell]
      const evidence = selectedScope !== undefined && adapter.selectConfigurationTarget !== undefined
        ? await adapter.selectConfigurationTarget(selectedScope)
        : await adapter.configurationTargetStatus()
      this.configurationTargets.set(shell, evidence)
      return evidence
    } catch {
      // This is intentionally a fixed, safe fact. The detailed path/launch arguments stay in the main-process adapter.
      const evidence: ConfigurationTargetEvidence = {
        shell, scope: 'unknown', override: 'unknown', writable: false, reason: 'unknown-launch-context'
      }
      this.configurationTargets.set(shell, evidence)
      return evidence
    }
  }

  private async refreshOfficialAuthentication(state: AiAccessState): Promise<void> {
    await Promise.all(aiAccessShells.map(async shell => {
      const reader = this.adapter(shell).officialAuthenticationStatus
      if (state.selected[shell] !== 'official' || reader === undefined) {
        this.officialAuthentications.delete(shell)
        return
      }
      try { this.officialAuthentications.set(shell, await reader()) } catch { this.officialAuthentications.delete(shell) }
    }))
  }

  /** 解除后的「恢复接入前配置」入口按这个可见性渲染；读不出就不显示，⛔ 摆必然失败的按钮。 */
  private async refreshRecoveryPoints(): Promise<void> {
    await Promise.all(aiAccessShells.map(async shell => {
      const probe = this.adapter(shell).recoveryPointStatus
      if (probe === undefined) {
        this.recoveryPoints.delete(shell)
        return
      }
      try { this.recoveryPoints.set(shell, await probe.call(this.adapter(shell))) } catch { this.recoveryPoints.delete(shell) }
    }))
  }

  private async ensureConfigurationTarget(shell: AiAccessShell, state: AiAccessState): Promise<void> {
    const evidence = await this.refreshConfigurationTarget(shell, state)
    if (evidence !== undefined && !evidence.writable) {
      this.recordUsage(shell, 'config-target', 'failure', evidence.reason)
      throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    }
    if (evidence !== undefined) this.recordUsage(shell, 'config-target', 'success')
  }

  /** 回执出口统一走这里：recordUsageEvent 的实现保证不抛，这里再兜一层，⛔ 因记录影响主流程。 */
  private recordUsage(shell: AiAccessShell, stage: UsageReceiptEvent['stage'], outcome: UsageReceiptEvent['outcome'], code?: string): void {
    try { this.extras.recordUsageEvent?.({ shell, stage, outcome, ...(code === undefined ? {} : { code }) }) } catch { /* 记录不进去也不能挡客户的操作 */ }
  }

  /**
   * A configuration target owns both the managed route and its pre-Toolbox backup.  Switching
   * targets halfway through would make “use official” or “restore previous” operate on a
   * different file and strand the original route.  The state intentionally stores no local
   * target path, so require an explicit clean finish before a target can change.
   */
  private assertConfigurationTargetChangeIsSafe(state: AiAccessState, shell: AiAccessShell): void {
    // `useOfficial()` has already removed the managed route, its backup sidecars and fingerprint.
    // Keeping its informational `official` selection must not strand a customer on the old target:
    // there is no Toolbox-owned connection left that a later target change could split apart.
    const hasManagedSelection = state.selected[shell] !== undefined && state.selected[shell] !== 'official'
    if (hasManagedSelection || state.relayShells?.includes(shell) ||
      state.pendingShells?.includes(shell) || state.shellFingerprints?.[shell] !== undefined) {
      throw new Error('AI_ACCESS_CONFIGURATION_TARGET_CHANGE_REQUIRES_CLEAN_CONNECTION')
    }
  }

  private configurationTargetNotice(shell: AiAccessShell): string | undefined {
    const target = this.configurationTargets.get(shell)
    if (target?.reason === 'symlinked-configuration') {
      const at = target.symlink !== undefined ? `（链接在 ${target.symlink.path}，真身在 ${target.symlink.target}）` : ''
      return `配置文件是软链${at}。工具箱不跟随软链写入：改动会影响所有指向同一个文件的配置。请自己决定——保留软链就直接改真身，或把链接换回普通文件后再点「启用」。`
    }
    if (target?.reason === 'project-config-overrides-user' && shell !== 'codex') return '检测到当前项目配置优先，请选择“按检测到的项目配置修复”。'
    if (target?.reason === 'managed-configuration') return '当前配置由管理策略控制，工具箱不能自动改写。'
    if (target?.reason === 'command-line-config-override') return '当前 AI 由启动参数指定配置，工具箱不能自动改写。'
    if (target?.reason === 'unreadable-configuration') return '当前配置无法读取，工具箱不能安全改写。'
    if (target?.reason === 'unknown-launch-context') return '当前 AI 的配置来源无法确认，工具箱不能自动改写。'
    return undefined
  }

  private inspectStates(state?: AiAccessState): Readonly<Record<AiAccessShell, ConfigurationState>> {
    return Object.fromEntries(aiAccessShells.map(shell => {
      const provider = state?.selected[shell]
      return [shell, !state || !isProvider(provider)
        ? 'not-managed'
        : isSuspendedSelection(state, shell)
          ? 'unknown'
          : !state.relayShells?.includes(shell) ? 'not-managed' : this.configurations.get(shell) ?? 'unknown']
    })) as Record<AiAccessShell, ConfigurationState>
  }

  private cachedConfigurations(): Readonly<Record<AiAccessShell, ConfigurationState>> {
    return Object.fromEntries(aiAccessShells.map(shell => [shell, this.configurations.get(shell) ?? 'unknown'])) as Record<AiAccessShell, ConfigurationState>
  }

  private connectionUrl(shell: AiAccessShell, provider: AiAccessProvider): string {
    return `${this.gateway!.baseUrl!}/${shell}/${provider}${shell === 'claude' ? '' : '/v1'}`
  }

  /** 只重启本机 API 服务：端口、令牌、已选模型与各壳配置都不动。 */
  private async restartGateway(): Promise<ApiFailure | undefined> {
    if (!this.gateway) return 'not_configured'
    return this.serialize(async () => {
      const state = await this.read().catch(() => undefined)
      if (!state) return 'configuration_failed'
      if (!state.relay) return 'not_configured'
      await this.gateway!.stop()
      try { await this.ensureGateway(state) } catch { return 'port_unavailable' }
      return undefined
    })
  }

  private remedyResult(shell: AiAccessShell, provider: AiAccessProvider | null, action: ApiRemedyAction,
    outcome: ApiRemedyResult['outcome'], code: ApiFailure | undefined, message: string): ApiRemedyResult {
    const next = code ? apiFailureRemedy[code] : null
    // 客服要看的是「客户试过什么、结果如何」，所以成功的处理动作也留痕。
    this.extras.recordFault?.({ shell, ...(provider ? { provider } : {}), ...(code ? { code } : {}), action, outcome })
    return { shell, provider, action, at: new Date().toISOString(), outcome, ...(code ? { code } : {}), message,
      ...(next && next !== action ? { next } : {}) }
  }

  async stop(): Promise<void> { await this.gateway?.stop() }

  /**
   * API-10：中止在飞的测速请求（服务面板「取消检查」/关闭面板）。不进 serialize 队列——
   * 排队被测速堵住时，取消恰恰要能立刻生效；它不读写任何状态，只中止网关在飞的 test 请求。
   */
  cancelTests(): number { return this.gateway?.cancelTests() ?? 0 }

  private markCheck(shell: AiAccessShell, provider: AiAccessProvider, ok: boolean, code?: ApiFailure, notice?: string, suggestedProvider?: AiAccessProvider): void {
    this.attempt = { shell, provider, at: new Date().toISOString(), ok, ...(code ? { code } : {}), ...(notice ? { notice } : {}), ...(suggestedProvider ? { suggestedProvider } : {}) }
    this.checks = [this.attempt, ...this.checks.filter(c => c.shell !== shell || c.provider !== provider)]
    // 闸门给的版本建议留在 ApiCheck.notice 供界面展示；记录里只留模板 id，⛔ 落自由文本。
    // 客户自己取消的测速不是故障：与客户端 client_aborted 的口径一致，⛔ 进故障记录。
    if (!ok && code !== 'client_aborted') this.extras.recordFault?.({ shell, provider, code: code ?? 'unknown', ...(code === 'shell_version_incompatible' ? { note: 'shell_version_incompatible' as const } : {}) })
  }

  private route(shell: AiAccessShell, provider: AiAccessProvider, key: string, state?: AiAccessState, model?: string): GatewayRoute {
    const contract = providerShellContract(provider, shell)
    if (contract.status !== 'supported') throw new Error('AI_ACCESS_PROVIDER_UNSUPPORTED')
    const resolved = this.extras.resolveRoute?.(shell, provider)
    const stored = state?.shellModels?.[shell]?.[provider]
    const storedModel = stored === undefined ? undefined : normalizeProviderModel(provider, shell, stored)
    const recipeModel = resolved === undefined ? undefined : normalizeProviderModel(provider, shell, resolved.model)
    const selected = model || storedModel || recipeModel || contract.defaultModel
    if (!isProviderModelAllowed(provider, shell, selected)) throw new Error('AI_ACCESS_MODEL_INVALID')
    return { shell, provider, key, endpoint: resolved?.endpoint ?? contract.endpoint, model: selected }
  }

  private async suggestedProviderForKey(shell: AiAccessShell, provider: AiAccessProvider, key: string, state: AiAccessState, code?: ApiFailure): Promise<AiAccessProvider | undefined> {
    // `invalid_token` and `product_mismatch` are shared by an actually invalid Kimi Key and a
    // Key issued by its sister product. Only a successful sister probe proves the latter.
    if (code !== 'key_rejected' || !this.gateway) return undefined
    const candidate = provider === 'kimi' ? 'moonshot' : provider === 'moonshot' ? 'kimi' : undefined
    if (candidate === undefined || !isProviderShellSupported(candidate, shell)) return undefined
    try { return (await this.gateway.probe(this.route(shell, candidate, key, state))).ok ? candidate : undefined } catch { return undefined }
  }

  private suggestedProviderNotice(provider: AiAccessProvider, suggested: AiAccessProvider): string {
    return `已验证这把 Key 可用于 ${modelProviders[suggested].title}，不能用于 ${modelProviders[provider].title}。可切换到建议入口后再启用。`
  }

  private modelChoices(shell: AiAccessShell, provider: AiAccessProvider): string[] {
    if (!isProviderShellSupported(provider, shell)) return []
    return [...providerShellContract(provider, shell).models]
  }

  private validateModel(shell: AiAccessShell, provider: AiAccessProvider, model: string): void {
    if (model && !isProviderModelAllowed(provider, shell, model)) throw new Error('AI_ACCESS_MODEL_INVALID')
  }

  private assertProviderShellSupported(shell: AiAccessShell, provider: AiAccessProvider): void {
    if (!isProviderShellSupported(provider, shell)) throw new Error('AI_ACCESS_PROVIDER_UNSUPPORTED')
  }

  /** 读某壳某服务商已保存的 Key（余额查询用）；从不进入界面。 */
  async providerKey(shell: AiAccessShell, provider: AiAccessProvider): Promise<string | undefined> {
    await this.pending
    return (await this.read()).shellKeys?.[shell]?.[provider]
  }

  private updateRoutes(state: AiAccessState): void {
    const suspended = aiAccessShells.some(shell => isSuspendedSelection(state, shell))
    const interrupted = aiAccessShells.some(shell => isInterruptedSelection(state, shell))
    const activeRelay = aiAccessShells.some(shell => activeRelayKey(state, shell) !== undefined)
    if (!activeRelay && ((state.pendingShells?.length ?? 0) > 0 || suspended || interrupted)) this.startupError = 'configuration_interrupted'
    else if (this.startupError === 'configuration_interrupted') this.startupError = undefined
    if (!this.gateway || !state.relay) return
    this.gateway.setRoutes(aiAccessShells.flatMap(shell => {
      const key = activeRelayKey(state, shell)
      if (key === undefined) return []
      const provider = state.selected[shell]
      if (!isProvider(provider)) return []
      try { return [this.route(shell, provider, key, state)] } catch { return [] }
    }))
  }

  private async beginChange(previous: AiAccessState, shell: AiAccessShell): Promise<void> {
    const pending: AiAccessState = { ...previous, pendingShells: [...new Set([...(previous.pendingShells ?? []), shell])] }
    await this.store.write(pending)
    this.updateRoutes(pending)
  }

  private async rollbackChange(previous: AiAccessState, rollback: () => Promise<void>): Promise<boolean> {
    try {
      await rollback()
      await this.store.write(previous)
      this.updateRoutes(previous)
      return true
    } catch { return false } // Keep the persisted write-ahead block and paused route.
  }

  private async ensureGateway(state: AiAccessState): Promise<AiAccessState> {
    if (!this.gateway) return state
    const token = state.relay?.token ?? randomBytes(32).toString('hex')
    const port = await this.gateway.start(state.relay?.port ?? 0, token)
    const next = state.relay ? state : { ...state, relay: { token, port } }
    try { if (!state.relay) await this.store.write(next) } catch (error) { await this.gateway.stop(); throw error }
    this.startupError = undefined
    this.updateRoutes(next)
    return next
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  private async read(): Promise<AiAccessState> {
    const stored = await this.store.read()
    if (!validAiAccessState(stored)) throw new Error('AI_ACCESS_STORAGE_INVALID')
    let state = withoutLegacyCodexTargetScope(stored)
    const migratedCodexTarget = state !== stored
    if (state.shellKeys !== undefined) {
      if (migratedCodexTarget) await this.store.write(state).catch(() => undefined)
      return state
    }
    // Preserve only existing legacy bindings. Never assign a shared Key to another shell.
    const shellKeys: Partial<Record<AiAccessShell, Partial<Record<AiAccessProvider, string>>>> = {}
    for (const shell of aiAccessShells) {
      const provider = state.selected[shell]
      if (!isProvider(provider)) continue
      const key = legacyKeyForProvider(state, provider)
      if (key) shellKeys[shell] = { [provider]: key }
    }
    state = { ...state, shellKeys }
    // A failed preference migration must not block a customer from returning to the valid user
    // target. The normalized in-memory state is still used, and any later normal state write
    // persists it atomically.
    if (migratedCodexTarget) await this.store.write(state).catch(() => undefined)
    return state
  }

  private adapter(shell: AiAccessShell): AiAccessAdapter {
    const adapter = this.adapters.get(shell)
    if (adapter === undefined) throw new Error('AI_ACCESS_SHELL_INVALID')
    return adapter
  }

  private publicStatus(state: AiAccessState): AiAccessStatus {
    return {
      legacyZaiKeySaved: state.zaiKey !== undefined,
      ...(this.attempt ? { attempt: this.attempt } : {}),
      ...(this.configurationTargets.size ? { configurationTargets: Object.fromEntries(this.configurationTargets) as AiAccessStatus['configurationTargets'] } : {}),
      ...(this.officialAuthentications.size ? { officialAuthentication: Object.fromEntries(this.officialAuthentications) as AiAccessStatus['officialAuthentication'] } : {}),
      shells: Object.fromEntries(aiAccessShells.map((shell) => [shell, {
        selected: isLegacyDirectSelection(state, shell) || isSuspendedSelection(state, shell) || isInterruptedSelection(state, shell)
          ? null : state.selected[shell] ?? null,
        officialAvailable: this.adapter(shell).deactivateToolboxConnection !== undefined || this.adapter(shell).activateOfficial !== undefined,
        providerKeys: Object.fromEntries(aiAccessProviders.map(provider => [provider, state.shellKeys?.[shell]?.[provider] !== undefined])),
        ...(() => {
          const provider = state.selected[shell]
          return isProvider(provider) && isSuspendedSelection(state, shell)
            ? { suspended: { provider, reason: 'provider-pending-verification' as const } } : {}
        })(),
        ...(() => {
          const provider = state.selected[shell]
          return isProvider(provider) && isInterruptedSelection(state, shell) && !isSuspendedSelection(state, shell)
            ? { interrupted: { provider, reason: 'configuration-interrupted' as const } } : {}
        })(),
        ...(() => {
          const provider = state.selected[shell]
          return isProvider(provider) && isLegacyDirectSelection(state, shell)
            ? { legacyDirect: { provider, reason: 'not-managed-by-current-gateway' } } : {}
        })(),
        ...(this.recoveryPoints.has(shell) ? { recoveryPointAvailable: this.recoveryPoints.get(shell) } : {})
      }])) as AiAccessStatus['shells']
    }
  }
}

export function validAiAccessState(value: unknown): value is AiAccessState {
  if (!record(value) || value.version !== 1 || !record(value.selected)) return false
  if (value.shellKeys !== undefined && (!record(value.shellKeys) || Object.entries(value.shellKeys).some(([shell, keys]) =>
    !aiAccessShells.includes(shell as AiAccessShell) || !record(keys) || Object.entries(keys).some(([provider, key]) =>
      !isProvider(provider) || typeof key !== 'string' || !keyPattern.test(key))))) return false
  if (value.shellModels !== undefined && (!record(value.shellModels) || Object.entries(value.shellModels).some(([shell, models]) =>
    !aiAccessShells.includes(shell as AiAccessShell) || !record(models) || Object.entries(models).some(([provider, model]) =>
      !isProvider(provider) || typeof model !== 'string' || !validStoredModel(shell as AiAccessShell, provider, model))))) return false
  if (legacyKeyFieldNames.some((field) => {
    const key = value[field]
    return key !== undefined && (typeof key !== 'string' || !keyPattern.test(key))
  })) return false
  if (value.zaiKey !== undefined && (typeof value.zaiKey !== 'string' || !keyPattern.test(value.zaiKey))) return false
  if (value.relayShells !== undefined && (!Array.isArray(value.relayShells) || value.relayShells.some(shell => !aiAccessShells.includes(shell)))) return false
  if (value.pendingShells !== undefined && (!Array.isArray(value.pendingShells) || value.pendingShells.some(shell => !aiAccessShells.includes(shell)))) return false
  if (value.configurationTargetScopes !== undefined && (!record(value.configurationTargetScopes) || Object.entries(value.configurationTargetScopes).some(([shell, scope]) =>
    !aiAccessShells.includes(shell as AiAccessShell) || (scope !== 'user' && scope !== 'project')))) return false
  if (value.shellFingerprints !== undefined && (!record(value.shellFingerprints) || Object.entries(value.shellFingerprints).some(([shell, print]) =>
    !aiAccessShells.includes(shell as AiAccessShell) || typeof print !== 'string' || !/^[a-f0-9]{64}$/.test(print)))) return false
  if (value.relay !== undefined && (!record(value.relay) || !Number.isInteger(value.relay.port) || Number(value.relay.port) < 1024 || Number(value.relay.port) > 65535 || typeof value.relay.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.relay.token))) return false
  return Object.entries(value.selected).every(([shell, mode]) =>
    aiAccessShells.includes(shell as AiAccessShell) && aiAccessModes.includes(mode as AiAccessMode)
  )
}

function withoutShell(prints: AiAccessState['shellFingerprints'], shell: AiAccessShell): AiAccessState['shellFingerprints'] {
  if (!prints || prints[shell] === undefined) return prints
  const next = Object.fromEntries(Object.entries(prints).filter(([name]) => name !== shell))
  return Object.keys(next).length ? next : undefined
}

/** Older builds could retain a Codex target selection. Codex always resolves its user config. */
function withoutLegacyCodexTargetScope(state: AiAccessState): AiAccessState {
  const scopes = state.configurationTargetScopes
  if (scopes?.codex === undefined) return state
  const next = Object.fromEntries(Object.entries(scopes).filter(([shell]) => shell !== 'codex')) as NonNullable<AiAccessState['configurationTargetScopes']>
  const withoutScopes = Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'configurationTargetScopes')) as AiAccessState
  return Object.keys(next).length ? { ...withoutScopes, configurationTargetScopes: next } : withoutScopes
}

function shellLabel(shell: AiAccessShell): string {
  return shell === 'codex' ? 'Codex' : shell === 'claude' ? 'Claude Code' : 'Hermes'
}

function legacyKeyForProvider(state: AiAccessState, provider: AiAccessProvider): string | undefined {
  const field = legacyKeyFields[provider]
  return field === undefined ? undefined : state[field]
}

/** Current routes are strict; a pending route may preserve a known historical model without becoming routable. */
function validStoredModel(shell: AiAccessShell, provider: AiAccessProvider, model: string): boolean {
  return isStoredProviderModelAllowed(provider, shell, model)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
