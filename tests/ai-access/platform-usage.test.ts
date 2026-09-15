import { describe, expect, it } from 'vitest'
import { readPlatformUsage, type PlatformUsageDeps } from '../../app/main/ai-access/platform-usage'
import type { LocalUsageResult } from '../../app/main/ai-access/local-usage'
import type { PlanQuotaResult, PlanQuotaSource } from '../../app/main/ai-access/plan-usage'

const quota = { level: 'pro', windows: [{ id: 'a', name: '周额度', usedPercent: 30, remainingPercent: 70, used: 30, limit: 100, resetsAt: null }] }
const localUsage = { days: 7, conversations: 3, requests: 40, tokens: 900_000, newestAt: 1_789_000_000_000 }

function deps(over: Partial<PlatformUsageDeps> = {}): PlatformUsageDeps {
  return {
    home: '/tmp/none',
    readQuota: async (source: PlanQuotaSource): Promise<PlanQuotaResult> => ({ source, quota: null, status: 'key-missing' }),
    providerKey: async () => undefined,
    officialPage: () => 'https://example.invalid/console',
    readLocal: async (): Promise<LocalUsageResult> => ({ usage: null, status: 'no-records' }),
    now: () => 1_789_000_000_000,
    ...over
  }
}

describe('平台用量报告', () => {
  it('读到官方套餐就显示套餐，本机记录不再顶上来', async () => {
    const report = await readPlatformUsage('zcode', deps({
      providerKey: async () => 'key',
      readQuota: async (source) => ({ source, quota, status: 'plan' }),
      readLocal: async () => ({ usage: localUsage, status: 'local' })
    }))
    expect(report).toMatchObject({ status: 'plan', plan: quota, local: null })
  })

  it('没填 Key 时退到本机统计，并且标明是估算口径的那一档状态', async () => {
    const report = await readPlatformUsage('kimi-code', deps({ readLocal: async () => ({ usage: localUsage, status: 'local' }) }))
    expect(report).toMatchObject({ status: 'local', plan: null, local: localUsage })
  })

  it('Key 被拒、连不上这类客户能处理的原因，盖过「本机没记录」说出来', async () => {
    for (const status of ['key-rejected', 'network-error', 'invalid-reply'] as const) {
      const report = await readPlatformUsage('zcode', deps({ providerKey: async () => 'key', readQuota: async (source) => ({ source, quota: null, status }) }))
      expect(report).toMatchObject({ status, plan: null, local: null })
    }
  })

  it('没 Key 又没本机记录时，说的是本机这一头的实情', async () => {
    expect(await readPlatformUsage('zcode', deps({ readLocal: async () => ({ usage: null, status: 'not-installed' }) }))).toMatchObject({ status: 'not-installed' })
    expect(await readPlatformUsage('zcode', deps({ readLocal: async () => ({ usage: null, status: 'unreadable' }) }))).toMatchObject({ status: 'unreadable' })
  })

  it('官方压根不提供用量查询的平台直接说不提供，⛔ 再去读 Key 或本机记录', async () => {
    let touched = false
    const probe = deps({ providerKey: async () => { touched = true; return 'key' }, readLocal: async () => { touched = true; return { usage: localUsage, status: 'local' } } })
    for (const platform of ['deepseek-harness', 'hermes'] as const) {
      expect(await readPlatformUsage(platform, probe)).toMatchObject({ status: 'none', plan: null, local: null, officialPage: 'https://example.invalid/console' })
    }
    expect(touched).toBe(false)
  })
  // 本机有记录就返回 status:'local'，官方那一头的结局原来整个丢掉——
  // 界面于是对 Key 填错、断网、没填 Key 的客户一律说「官方没有提供用量接口」，客户不会去修 Key。
  it('本机估算顶上来时，官方那一头为什么没读到要跟着送出去', async () => {
    for (const status of ['key-rejected', 'network-error', 'invalid-reply'] as const) {
      const report = await readPlatformUsage('zcode', deps({
        providerKey: async () => 'key',
        readQuota: async (source) => ({ source, quota: null, status }),
        readLocal: async () => ({ usage: localUsage, status: 'local' })
      }))
      expect(report).toMatchObject({ status: 'local', local: localUsage, officialStatus: status })
    }
    // 没填 Key 走的是同一条路，同样 ⛔ 被说成「这家官方不提供」。
    expect(await readPlatformUsage('kimi-code', deps({ readLocal: async () => ({ usage: localUsage, status: 'local' }) })))
      .toMatchObject({ status: 'local', officialStatus: 'key-missing' })
    // 只有真没有接口的平台才是 none；读到套餐的是 plan。
    expect(await readPlatformUsage('deepseek-harness', deps())).toMatchObject({ status: 'none', officialStatus: 'none' })
    expect(await readPlatformUsage('zcode', deps({ providerKey: async () => 'key', readQuota: async (source) => ({ source, quota, status: 'plan' }) })))
      .toMatchObject({ status: 'plan', officialStatus: 'plan' })
    // 两头都没读到时，原因也要跟着，界面才能给出对应的动作。
    expect(await readPlatformUsage('zcode', deps({ providerKey: async () => 'key', readQuota: async (source) => ({ source, quota: null, status: 'network-error' }) })))
      .toMatchObject({ status: 'network-error', officialStatus: 'network-error' })
  })

  it('本机记录只读到一部分时，残缺这件事跟着报告一起送到界面', async () => {
    expect(await readPlatformUsage('kimi-code', deps({ readLocal: async () => ({ usage: localUsage, status: 'local', partial: true }) })))
      .toMatchObject({ status: 'local', partial: true })
    expect(await readPlatformUsage('kimi-code', deps({ readLocal: async () => ({ usage: localUsage, status: 'local' }) }))).not.toHaveProperty('partial')
  })

  it('Claude 通过自己的官方客户端读套餐，失败不能说成官方不提供', async () => {
    expect(await readPlatformUsage('claude-code', deps({ readClaude: async () => ({ status: 'plan', plan: quota }) }))).toMatchObject({ status: 'plan', plan: quota })
    expect(await readPlatformUsage('claude-code', deps())).toMatchObject({ status: 'official-unavailable', plan: null })
  })
})
