import type { AiAccessMode, AiAccessShell, AiAccessStatus } from '../../../main/ai-access/service'
import { apiFailureMessages, type ApiCheck } from '../../../shared/api-service-types'
import { modelProviderIds, type ModelProviderId } from '../../../shared/model-providers'

type CodexOfficialLoginStatus = 'idle' | 'pending' | 'connected' | 'failed'
export type ClaudeOfficialLoginStatus = 'idle' | 'pending' | 'code-required' | 'connected' | 'failed' | 'not-installed'
type ConfigurationTargetEvidence = Exclude<NonNullable<AiAccessStatus['configurationTargets']>[AiAccessShell], undefined>

export function readAccessStatus(snapshot: string): AiAccessStatus {
  const value = JSON.parse(snapshot)
  if (!isRecord(value) || !isRecord(value.shells)) throw new Error('AI_ACCESS_STATUS_INVALID')
  const shells = {} as Record<AiAccessShell, AiAccessStatus['shells'][AiAccessShell]>
  for (const shell of ['codex', 'claude', 'hermes'] as const) {
    const detail = value.shells[shell]
    if (!isRecord(detail) || typeof detail.officialAvailable !== 'boolean' || !validMode(detail.selected)) throw new Error('AI_ACCESS_STATUS_INVALID')
    const suspended = readSuspended(detail.suspended)
    const interrupted = readInterrupted(detail.interrupted)
    const legacyDirect = readLegacyDirect(detail.legacyDirect)
    shells[shell] = { selected: detail.selected, officialAvailable: detail.officialAvailable, providerKeys: readProviderKeys(detail.providerKeys),
      ...(suspended ? { suspended } : {}), ...(interrupted ? { interrupted } : {}), ...(legacyDirect ? { legacyDirect } : {}),
      ...(detail.recoveryPointAvailable === undefined ? {} : { recoveryPointAvailable: detail.recoveryPointAvailable === true }) }
  }
  const attempt = readApiCheck(value.attempt)
  const configurationTargets = readConfigurationTargets(value.configurationTargets)
  const officialAuthentication = readOfficialAuthentication(value.officialAuthentication)
  const storageNote = readStorageNote(value.storageNote)
  return {
    legacyZaiKeySaved: value.legacyZaiKeySaved === true,
    ...(storageNote ? { storageNote } : {}),
    ...(attempt ? { attempt } : {}),
    ...(configurationTargets ? { configurationTargets } : {}),
    ...(officialAuthentication ? { officialAuthentication } : {}),
    shells
  }
}

export function readCodexLoginStatus(snapshot: string): CodexOfficialLoginStatus {
  const value = JSON.parse(snapshot)
  if (!isRecord(value) || !['idle', 'pending', 'connected', 'failed'].includes(value.status as string)) throw new Error('AI_ACCESS_LOGIN_STATUS_INVALID')
  return value.status as CodexOfficialLoginStatus
}

export function readClaudeLoginStatus(snapshot: string): ClaudeOfficialLoginStatus {
  const value = JSON.parse(snapshot)
  if (!isRecord(value) || !['idle', 'pending', 'code-required', 'connected', 'failed', 'not-installed'].includes(value.status as string)) throw new Error('AI_ACCESS_LOGIN_STATUS_INVALID')
  return value.status as ClaudeOfficialLoginStatus
}

function validMode(value: unknown): value is AiAccessMode | null {
  return value === null || value === 'zai' || value === 'official' || modelProviderIds.includes(value as ModelProviderId)
}

function readProviderKeys(value: unknown): AiAccessStatus['shells'][AiAccessShell]['providerKeys'] {
  if (!isRecord(value)) throw new Error('AI_ACCESS_STATUS_INVALID')
  const keys = {} as Record<ModelProviderId, boolean>
  for (const provider of modelProviderIds) {
    if (typeof value[provider] !== 'boolean') throw new Error('AI_ACCESS_STATUS_INVALID')
    keys[provider] = value[provider] === true
  }
  return keys
}

/** The renderer receives a fixed pause reason only; local config paths and route details stay in main. */
function readSuspended(value: unknown): AiAccessStatus['shells'][AiAccessShell]['suspended'] {
  if (value === undefined) return undefined
  if (!isRecord(value) || !modelProviderIds.includes(value.provider as ModelProviderId) || value.reason !== 'provider-pending-verification') {
    throw new Error('AI_ACCESS_STATUS_INVALID')
  }
  return { provider: value.provider as ModelProviderId, reason: 'provider-pending-verification' }
}

/** A supported route can be paused while a configuration write or restart is unfinished. */
function readInterrupted(value: unknown): AiAccessStatus['shells'][AiAccessShell]['interrupted'] {
  if (value === undefined) return undefined
  if (!isRecord(value) || !modelProviderIds.includes(value.provider as ModelProviderId) || value.reason !== 'configuration-interrupted') {
    throw new Error('AI_ACCESS_STATUS_INVALID')
  }
  return { provider: value.provider as ModelProviderId, reason: 'configuration-interrupted' }
}

/** An older direct configuration is intentionally not promoted to a current gateway route. */
function readLegacyDirect(value: unknown): AiAccessStatus['shells'][AiAccessShell]['legacyDirect'] {
  if (value === undefined) return undefined
  if (!isRecord(value) || !modelProviderIds.includes(value.provider as ModelProviderId) || value.reason !== 'not-managed-by-current-gateway') {
    throw new Error('AI_ACCESS_STATUS_INVALID')
  }
  return { provider: value.provider as ModelProviderId, reason: 'not-managed-by-current-gateway' }
}

/** Renderer receives only the decision, never a config path, startup argument, or environment value. */
function readConfigurationTargets(value: unknown): AiAccessStatus['configurationTargets'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('AI_ACCESS_STATUS_INVALID')
  const targets: Partial<Record<AiAccessShell, ConfigurationTargetEvidence>> = {}
  const reasons = ['project-config-overrides-user', 'project-configuration-ignored', 'managed-configuration', 'command-line-config-override', 'unreadable-configuration', 'symlinked-configuration', 'unknown-launch-context']
  for (const shell of ['codex', 'claude', 'hermes'] as const) {
    const target = value[shell]
    if (target === undefined) continue
    if (!isRecord(target) || target.shell !== shell || !['user', 'project', 'unknown'].includes(String(target.scope)) ||
      !['none', 'project', 'managed', 'command-line', 'unknown'].includes(String(target.override)) || typeof target.writable !== 'boolean' ||
      (target.reason !== undefined && !reasons.includes(String(target.reason)))) throw new Error('AI_ACCESS_STATUS_INVALID')
    // 软链配置带链接与真身两个路径：这是客户决定「改链接还是改真身」的依据，缺一不可。
    let symlink: ConfigurationTargetEvidence['symlink']
    if (target.symlink !== undefined) {
      if (!isRecord(target.symlink) || typeof target.symlink.path !== 'string' || typeof target.symlink.target !== 'string') {
        throw new Error('AI_ACCESS_STATUS_INVALID')
      }
      symlink = { path: target.symlink.path, target: target.symlink.target }
    }
    targets[shell] = {
      shell,
      scope: target.scope as ConfigurationTargetEvidence['scope'],
      override: target.override as ConfigurationTargetEvidence['override'],
      writable: target.writable,
      ...(target.reason === undefined ? {} : { reason: target.reason as ConfigurationTargetEvidence['reason'] }),
      ...(symlink !== undefined ? { symlink } : {})
    }
  }
  return Object.keys(targets).length ? targets : undefined
}

/** The main process emits one fixed remediation after it isolates unreadable encrypted storage. */
function readStorageNote(value: unknown): AiAccessStatus['storageNote'] {
  return value === '保存的 Key 已失效，请重新添加。' ? value : undefined
}

/** Codex auth.json is inspected only in the main process. The renderer gets this fixed vocabulary, never file content. */
function readOfficialAuthentication(value: unknown): AiAccessStatus['officialAuthentication'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('AI_ACCESS_STATUS_INVALID')
  const states = ['official', 'login-required']
  const reasons = ['chatgpt-session', 'other-tool-api-key', 'no-authentication', 'unrecognized-authentication']
  type OfficialAuthenticationStatus = NonNullable<NonNullable<AiAccessStatus['officialAuthentication']>[AiAccessShell]>
  const statuses: Partial<Record<AiAccessShell, OfficialAuthenticationStatus>> = {}
  for (const shell of ['codex', 'claude', 'hermes'] as const) {
    const status = value[shell]
    if (status === undefined) continue
    if (!isRecord(status) || !states.includes(String(status.state)) || !reasons.includes(String(status.reason))) {
      throw new Error('AI_ACCESS_STATUS_INVALID')
    }
    statuses[shell] = { state: status.state as 'official' | 'login-required', reason: status.reason as 'chatgpt-session' | 'other-tool-api-key' | 'no-authentication' | 'unrecognized-authentication' }
  }
  return Object.keys(statuses).length ? statuses : undefined
}

export function readApiCheck(value: unknown): ApiCheck | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !['codex','claude','hermes'].includes(String(value.shell)) || !modelProviderIds.includes(value.provider as ModelProviderId) || typeof value.ok !== 'boolean' || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw new Error('AI_ACCESS_STATUS_INVALID')
  if (value.code !== undefined && !Object.hasOwn(apiFailureMessages, String(value.code))) throw new Error('AI_ACCESS_STATUS_INVALID')
  if (value.notice !== undefined && typeof value.notice !== 'string') throw new Error('AI_ACCESS_STATUS_INVALID')
  if (value.suggestedProvider !== undefined && !modelProviderIds.includes(value.suggestedProvider as ModelProviderId)) throw new Error('AI_ACCESS_STATUS_INVALID')
  return { shell: value.shell as ApiCheck['shell'], provider: value.provider as ApiCheck['provider'], ok: value.ok, at: value.at,
    ...(value.code ? { code: value.code as ApiCheck['code'] } : {}), ...(typeof value.notice === 'string' && value.notice ? { notice: value.notice.slice(0, 400) } : {}),
    ...(value.suggestedProvider ? { suggestedProvider: value.suggestedProvider as ModelProviderId } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
