export interface SkeletonTab {
  readonly id: TabId
  readonly label: string
  readonly group: 'services' | 'account'
  readonly sidebar?: boolean
}

export type UsagePlatformId = 'codex' | 'claude-code' | 'hermes' | 'deepseek-harness' | 'zcode' | 'kimi-code'
export type MorePlatformId = UsagePlatformId

export interface MorePlatformEntry {
  readonly id: MorePlatformId
  readonly label: string
}

export type TabId = 'dashboard' | 'tunnel' | 'usage' | 'platform-layout' | 'purchase' | 'sharing' | 'account' | 'referral' | 'settings'

export const skeletonTabs: readonly SkeletonTab[] = [
  { id: 'dashboard', label: '仪表盘', group: 'services' },
  { id: 'usage', label: 'Codex', group: 'services', sidebar: false },
  { id: 'platform-layout', label: '管理平台布局', group: 'services', sidebar: false },
  { id: 'purchase', label: '账号订阅', group: 'services' },
  { id: 'sharing', label: '账号分享', group: 'services' },
  { id: 'tunnel', label: 'AI网络配置', group: 'services' },
  { id: 'referral', label: '邀请有礼', group: 'account' },
  { id: 'account', label: '我的账号', group: 'account' },
  { id: 'settings', label: '设置', group: 'account' }
]

// 首次使用默认固定三个常用平台，六个平台都可以移入、移出和重新排序。
export const defaultPinnedPlatformIds: readonly MorePlatformId[] = ['codex', 'claude-code', 'hermes']
export const pinnedPlatformStorageKey = 'laixin-ai-toolbox.pinned-platforms.v2'
export const legacyPinnedPlatformStorageKey = 'laixin-ai-toolbox.pinned-platforms'

export const morePlatformTrigger = {
  afterTab: 'usage',
  label: '更多平台'
} as const

export const morePlatformEntries: readonly MorePlatformEntry[] = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'hermes', label: 'Hermes' },
  { id: 'deepseek-harness', label: 'DeepSeek Harness' },
  { id: 'zcode', label: '智谱 ZCode' },
  { id: 'kimi-code', label: 'Kimi Code' }
]

export function usagePlatformLabel(platform: UsagePlatformId): string {
  return morePlatformEntries.find((entry) => entry.id === platform)?.label ?? 'Codex'
}

export function isMorePlatformId(value: unknown): value is MorePlatformId {
  return typeof value === 'string' && morePlatformEntries.some((platform) => platform.id === value)
}

export function normalizePinnedPlatformIds(value: unknown): MorePlatformId[] {
  if (!Array.isArray(value)) return []
  const unique = new Set<MorePlatformId>()
  for (const item of value) {
    if (isMorePlatformId(item)) unique.add(item)
  }
  return [...unique]
}

export function pinPlatform(ids: readonly MorePlatformId[], platformId: MorePlatformId): MorePlatformId[] {
  const normalized = normalizePinnedPlatformIds(ids)
  return normalized.includes(platformId) ? normalized : [...normalized, platformId]
}

export function unpinPlatform(ids: readonly MorePlatformId[], platformId: MorePlatformId): MorePlatformId[] {
  return normalizePinnedPlatformIds(ids).filter((id) => id !== platformId)
}

export function movePinnedPlatform(
  ids: readonly MorePlatformId[],
  movingId: MorePlatformId,
  targetId: MorePlatformId,
  placeAfter = false
): MorePlatformId[] {
  const normalized = normalizePinnedPlatformIds(ids)
  if (movingId === targetId || !normalized.includes(movingId) || !normalized.includes(targetId)) return normalized
  const remaining = normalized.filter((id) => id !== movingId)
  const targetIndex = remaining.indexOf(targetId)
  remaining.splice(targetIndex + (placeAfter ? 1 : 0), 0, movingId)
  return remaining
}

export interface PlatformLayoutStorage {
  getItem(key: string): string | null
}

export function readPinnedPlatformIds(storage: PlatformLayoutStorage | undefined): MorePlatformId[] {
  if (storage === undefined) return [...defaultPinnedPlatformIds]
  try {
    const current = storage.getItem(pinnedPlatformStorageKey)
    if (current !== null) return normalizePinnedPlatformIds(JSON.parse(current))
    const legacy = storage.getItem(legacyPinnedPlatformStorageKey)
    if (legacy === null) return [...defaultPinnedPlatformIds]
    return normalizePinnedPlatformIds(['codex', ...normalizePinnedPlatformIds(JSON.parse(legacy))])
  } catch {
    return [...defaultPinnedPlatformIds]
  }
}

export function isTabId(value: string): value is TabId {
  return skeletonTabs.some((tab) => tab.id === value)
}

export function nextTabIndex(currentIndex: number, direction: -1 | 1, count = skeletonTabs.length): number {
  return (currentIndex + direction + count) % count
}
