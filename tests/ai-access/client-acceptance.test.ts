import { describe, expect, it } from 'vitest'
import { ClientAcceptanceTracker, type ClientAcceptanceRoute } from '../../app/main/ai-access/client-acceptance'

const deepseek: ClientAcceptanceRoute = {
  shell: 'codex', provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/responses', revision: 'route-deepseek-1'
}

describe('真实客户端调用验收', () => {
  it('只有仍是当前路由版本的成功调用才能证明客户正在使用该 API', () => {
    const tracker = new ClientAcceptanceTracker()
    tracker.replaceRoutes([deepseek])
    tracker.record(deepseek, '2026-09-13T08:00:00.000Z')
    expect(tracker.acceptances()).toEqual({
      codex: { shell: 'codex', provider: 'deepseek', model: 'deepseek-flash', revision: 'route-deepseek-1', at: '2026-09-13T08:00:00.000Z', lastAt: '2026-09-13T08:00:00.000Z' }
    })

    const kimi: ClientAcceptanceRoute = { ...deepseek, provider: 'kimi', model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1/responses', revision: 'route-kimi-2' }
    tracker.replaceRoutes([kimi])
    expect(tracker.acceptances()).toEqual({})

    // 切换前已经在路上的请求晚到，不能给新渠道打上「实际在用」的勾。
    tracker.record(deepseek, '2026-09-13T08:00:01.000Z')
    expect(tracker.acceptances()).toEqual({})

    tracker.record(kimi, '2026-09-13T08:00:02.000Z')
    expect(tracker.acceptances()).toEqual({
      codex: { shell: 'codex', provider: 'kimi', model: 'kimi-for-coding', revision: 'route-kimi-2', at: '2026-09-13T08:00:02.000Z', lastAt: '2026-09-13T08:00:02.000Z' }
    })
  })

  it('重复同步同一 revision 不清掉已经观察到的客户调用', () => {
    const tracker = new ClientAcceptanceTracker()
    tracker.replaceRoutes([deepseek])
    tracker.record(deepseek, '2026-09-13T08:00:00.000Z')
    tracker.record(deepseek, '2026-09-13T08:00:01.000Z')
    tracker.replaceRoutes([{ ...deepseek }])
    expect(tracker.acceptances().codex?.at).toBe('2026-09-13T08:00:00.000Z')
    expect(tracker.acceptances().codex?.lastAt).toBe('2026-09-13T08:00:01.000Z')
  })

  it('最近成功只向前更新，首次验收和已读快照不随后续调用改变', () => {
    const tracker = new ClientAcceptanceTracker()
    tracker.replaceRoutes([deepseek])
    tracker.record(deepseek, '2026-09-13T08:00:00.000Z')
    const first = tracker.acceptances().codex
    tracker.record(deepseek, '2026-09-13T08:11:00.000Z')
    tracker.record(deepseek, '2026-09-13T08:10:00.000Z')
    expect(tracker.acceptances().codex).toMatchObject({ at: '2026-09-13T08:00:00.000Z', lastAt: '2026-09-13T08:11:00.000Z' })
    expect(first).toMatchObject({ at: '2026-09-13T08:00:00.000Z', lastAt: '2026-09-13T08:00:00.000Z' })
  })

  it('同服务商换绑定后旧请求不刷新新证据，失效与退出清除最近成功', () => {
    const tracker = new ClientAcceptanceTracker()
    tracker.replaceRoutes([deepseek])
    tracker.record(deepseek, '2026-09-13T08:00:00.000Z')
    const next = { ...deepseek, revision: 'route-deepseek-2' }
    tracker.replaceRoutes([next])
    expect(tracker.acceptances()).toEqual({})
    tracker.record(next, '2026-09-13T08:11:00.000Z')
    expect(tracker.record(deepseek, '2026-09-13T08:12:00.000Z')).toBe(false)
    expect(tracker.acceptances().codex?.lastAt).toBe('2026-09-13T08:11:00.000Z')
    tracker.invalidate('codex')
    expect(tracker.acceptances()).toEqual({})
    tracker.record(next, '2026-09-13T08:13:00.000Z')
    tracker.clear()
    expect(tracker.acceptances()).toEqual({})
    expect(tracker.record(next, '2026-09-13T08:14:00.000Z')).toBe(false)
  })

  it('Claude 的已白名单小模型仍归入同一条当前路由，并记录实际调用模型', () => {
    const tracker = new ClientAcceptanceTracker()
    const claude: ClientAcceptanceRoute = {
      shell: 'claude', provider: 'deepseek', model: 'deepseek-v4-pro', endpoint: 'https://api.deepseek.com/anthropic/v1/messages', revision: 'route-claude-1'
    }
    tracker.replaceRoutes([claude])

    expect(tracker.record({ ...claude, model: 'deepseek-v4-flash' }, '2026-09-13T08:00:00.000Z')).toBe(true)
    expect(tracker.acceptances().claude).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash', revision: 'route-claude-1' })
  })
})
