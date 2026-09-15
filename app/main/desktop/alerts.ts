import { createHash } from 'node:crypto'
import type { AccountView } from '../../account-types'
import type { DesktopAlert } from '../../desktop-types'
import type { UsageReport } from '../codex-usage/types'

const keyOf = (value: string): string => createHash('sha256').update(value).digest('hex')
export function quotaAlerts(ai: UsageReport | undefined, network: AccountView | undefined, now = Date.now()): DesktopAlert[] {
  const alerts: DesktopAlert[] = []
  if (ai?.status === 'ready' && ai.snapshot && now - ai.snapshot.fetchedAt < 10 * 60_000) {
    for (const bucket of ai.snapshot.buckets) {
      for (const window of [bucket.primary, bucket.secondary]) {
        if (!window || window.remainingPercent === null || window.remainingPercent > 10 || window.remainingPercent < 0 ||
          (window.resetsAt !== null && window.resetsAt * 1_000 <= now)) continue
        const period = window.windowDurationMins === 10_080 ? '本周' : window.windowDurationMins ? `${window.windowDurationMins / 60} 小时周期` : '当前周期'
        alerts.push({ id: keyOf(`ai:${ai.snapshot.accountKey ?? ai.snapshot.accountLabel}:${bucket.name}:${window.windowDurationMins}:${window.resetsAt ?? Math.floor(now / 86_400_000)}`),
          kind: 'ai', message: `${bucket.name} ${period}额度剩余 ${Math.round(window.remainingPercent)}%，可在 AI 用量查看恢复时间。` })
      }
    }
  }
  const overview = network?.state === 'signed-in' && !network.code ? network.overview : null
  const usages = overview ? [overview.trial.usage, overview.subscription].filter((usage) => usage !== null) : []
  // An unreadable allocation is not zero. Do not warn while any potentially usable allocation is unknown.
  if (usages.some((usage) => usage.state === 'unknown' || (['active', 'exhausted'].includes(usage.state) && usage.measurement !== 'current'))) return alerts
  const available = usages.filter((usage) => ['active', 'exhausted'].includes(usage.state) && usage.expiresAt !== null && usage.expiresAt > now)
  if (available.length && available.every((usage) => usage.remainingBytes !== null && usage.observedAt !== null && now - usage.observedAt < 10 * 60_000)) {
    const remaining = available.reduce((sum, usage) => sum + usage.remainingBytes!, 0)
    const total = available.reduce((sum, usage) => sum + usage.totalBytes!, 0)
    if (total > 0 && remaining / total <= 0.1) alerts.push({
      id: keyOf(`network:${network?.account?.id}:${available.map((usage) => `${usage.authorizationId}:${usage.expiresAt}`).sort().join(',')}`),
      kind: 'network', message: `网络流量剩余 ${(remaining / 1024 ** 3).toFixed(2)} GB，可在 AI网络查看套餐。`
    })
  }
  return alerts
}
