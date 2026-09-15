import type { AiAccessProvider, AiAccessShell, AiAccessStatus } from '../../../main/ai-access/service'
import type { StoredPrecheckReport } from '../../../main/precheck/types'
import type { UsagePlatformId } from '../tabs'
import { isProviderShellSupported, modelProviderIds } from '../../../shared/model-providers'

export function accessShell(platform: UsagePlatformId): AiAccessShell | null {
  if (platform === 'claude-code') return 'claude'
  return platform === 'codex' || platform === 'hermes' ? platform : null
}

/** 壳 → 它在界面上的平台页。`accessShell` 的反向表。 */
const shellPlatforms = [['codex', 'codex'], ['claude', 'claude-code'], ['hermes', 'hermes']] as const

/**
 * 要填某家服务商的 Key，该去哪个平台页。只有接入壳（Codex / Claude Code / Hermes）的「模型 API」页
 * 才有 Key 编辑器；只在已经完成原生验收的壳中，优先当前已经存了这家 Key 的那个壳
 * （客户多半是回来改它）。都没存过、或状态还没读到，就落到该服务商第一个可用的壳。
 * 一个旧 Key 留在尚未验收的壳中，也不能把客户带到禁用的卡片。
 */
export function providerKeyShellPlatform(provider: AiAccessProvider, status: AiAccessStatus | null): UsagePlatformId {
  const supported = shellPlatforms.filter(([shell]) => isProviderShellSupported(provider, shell))
  const saved = supported.find(([shell]) => status?.shells[shell].providerKeys[provider] === true)
  return (saved ?? supported[0] ?? shellPlatforms[0])[1]
}

export function usesDeepSeek(platform: UsagePlatformId, status: AiAccessStatus | null): boolean {
  return selectedModelApiProvider(platform, status) === 'deepseek'
}

export function selectedModelApiProvider(platform: UsagePlatformId, status: AiAccessStatus | null): AiAccessProvider | null {
  const shell = accessShell(platform)
  if (shell !== null && (status?.shells[shell].suspended !== undefined || status?.shells[shell].interrupted !== undefined)) return null
  const selected = shell === null ? null : status?.shells[shell].selected
  return modelProviderIds.includes(selected as AiAccessProvider) ? selected as AiAccessProvider : null
}

export function installationSummary(platform: UsagePlatformId, report: StoredPrecheckReport): { state: string; version: string; checkedAt: string | null } {
  const software = accessShell(platform)
  if (!software) return { state: '官方原版', version: '暂未接入版本检测', checkedAt: null }
  if (report.state !== 'complete') return { state: '尚未检测', version: '未检测', checkedAt: null }
  const item = report.software.find(entry => entry.software === software)
  const version = item?.installation?.version
  const knownVersion = version?.status === 'available' && typeof version.value === 'string' && /^[\w.+-]{1,48}$/.test(version.value)
    ? version.value : '暂未读到版本'
  return {
    state: item?.displayKind === 'detected' ? '检测到安装' : item?.displayKind === 'installable' ? '未检测到安装' : '安装状态待确认',
    version: knownVersion,
    checkedAt: report.collectedAt
  }
}
