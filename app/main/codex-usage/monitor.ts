import { codexAccountKey, label, maskAccount, normalizeBuckets } from './normalize'
import { UsageReadError, type CodexReadResult } from './client'
import { REFRESH_COOLDOWN_MS, type UsageReport } from './types'

export function createUsageMonitor(read: (signal: AbortSignal) => Promise<CodexReadResult>, now = Date.now) {
  let report: UsageReport = { status: 'idle', snapshot: null, checkedAt: null, nextRefreshAt: null }
  let pending: Promise<UsageReport> | undefined
  let controller: AbortController | undefined
  let disposed = false
  let checkedAccountKey: string | undefined

  async function update(): Promise<UsageReport> {
    controller = new AbortController()
    try {
      const data = await read(controller.signal)
      if (disposed) return report
      const buckets = normalizeBuckets(data.limits)
      if (buckets.length === 0) throw new UsageReadError('unavailable')
      report = {
        status: 'ready', checkedAt: now(), nextRefreshAt: now() + REFRESH_COOLDOWN_MS,
        snapshot: { accountKey: codexAccountKey(data.account), accountLabel: maskAccount(data.account.email), plan: label(data.account.planType, 40), fetchedAt: now(), buckets }
      }
    } catch (error) {
      if (disposed) return report
      // An unsuccessful read cannot establish the current account: never carry its previous quota forward.
      report = { status: error instanceof UsageReadError ? error.status : 'unavailable', snapshot: null, checkedAt: now(), nextRefreshAt: now() + REFRESH_COOLDOWN_MS }
    }
    return report
  }

  return {
    last: (): UsageReport => report,
    refresh: (accountKey?: string): Promise<UsageReport> => {
      if (disposed) return Promise.resolve({ ...report, status: 'unavailable', snapshot: null })
      const forAccount = (value: UsageReport): UsageReport => accountKey && value.snapshot && value.snapshot.accountKey !== accountKey
        ? { ...value, status: 'account-changed', snapshot: null } : value
      if (pending) return pending.then(forAccount)
      if (report.nextRefreshAt !== null && now() < report.nextRefreshAt && (!accountKey || accountKey === (report.snapshot?.accountKey ?? checkedAccountKey))) return Promise.resolve(forAccount(report))
      checkedAccountKey = accountKey
      pending = update().finally(() => { pending = undefined })
      return pending.then(forAccount)
    },
    dispose: (): void => { disposed = true; controller?.abort(); report = { status: 'idle', snapshot: null, checkedAt: null, nextRefreshAt: null } }
  }
}
