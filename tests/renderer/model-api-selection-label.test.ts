import { describe, expect, it } from 'vitest'
import { currentSelection, selectionActionLabel } from '../../app/renderer/src/platform/model-api'
import { usageStageFor, usageStageViews } from '../../app/renderer/src/platform/usage-stages'
import type { AiAccessStatus } from '../../app/main/ai-access/service'
import type { ApiUsageStage } from '../../app/shared/api-service-types'
import { modelProviderIds, type ModelProviderId } from '../../app/shared/model-providers'

const emptyKeys = (): Record<ModelProviderId, boolean> => Object.fromEntries(modelProviderIds.map((provider) => [provider, false])) as Record<ModelProviderId, boolean>

const status = (codex: Partial<AiAccessStatus['shells']['codex']> = {}): AiAccessStatus => ({ shells: {
  codex: { selected: null, officialAvailable: true, providerKeys: emptyKeys(), ...codex },
  claude: { selected: null, officialAvailable: true, providerKeys: emptyKeys() },
  hermes: { selected: null, officialAvailable: false, providerKeys: emptyKeys() }
} })

const codexStage = (provider: ModelProviderId, observedClientCall: string | null): ApiUsageStage => ({
  shell: 'codex', provider, tested: '2026-09-15T02:00:00.000Z', configured: '2026-09-15T02:01:00.000Z',
  observedClientCall, configuration: 'ok'
})

describe('配置好了，不等于软件已经用上（API-01）', () => {
  it('选中但未观察到客户端调用的来源，按钮只能说配置口径，⛔ 冒充「使用中」', () => {
    const codex = status({ selected: 'deepseek', providerKeys: { ...emptyKeys(), deepseek: true } })
    expect(currentSelection('codex', codex, 'deepseek')).toBe(true)
    const label = selectionActionLabel(currentSelection('codex', codex, 'deepseek'))
    expect(label).toBe('已配置')
    expect(label).not.toBe('使用中')
    // 选中本身不点亮三态第三步：observedClientCall 为空时给的是「怎么触发」，不是成功勾。
    const views = usageStageViews(codexStage('deepseek', null))
    expect(views.map(view => view.state)).toEqual(['done', 'done', 'waiting', 'waiting'])
    expect(views[2].detail).toContain('CLI 调用和桌面版调用都会记在这里')
  })

  it('接口自测或写配置成功都不点亮调用与桌面版；真实调用证据到达后三态才显示完成', () => {
    const waiting = usageStageViews({ ...codexStage('deepseek', null), codexDesktopRoute: { status: 'unverified', at: null, reason: 'awaiting_desktop_request' } })
    expect(waiting.map(view => view.label)).toEqual(['接口测试过', '配置已写', '已观察到 Codex 调用（CLI/桌面版）', 'Codex 桌面版已验证'])
    expect(waiting.slice(2).map(view => view.state)).toEqual(['waiting', 'waiting'])
    const done = usageStageViews({ ...codexStage('deepseek', '2026-09-15T02:05:00.000Z'), codexDesktopRoute: { status: 'unverified', at: null, reason: 'awaiting_desktop_request' } })
    expect(done[2].state).toBe('done')
    expect(done[3].state).toBe('waiting')
  })

  it('切来源、证据缺失、暂停、中断、读状态失败都不得沿用「已配置」', () => {
    const codex = status({ selected: 'zhipu-api', providerKeys: { ...emptyKeys(), 'zhipu-api': true } })
    expect(currentSelection('codex', codex, 'deepseek')).toBe(false)
    expect(selectionActionLabel(currentSelection('codex', codex, 'deepseek'))).toBe('启用')
    expect(currentSelection('codex', null, 'zhipu-api')).toBe(false)
    const suspended = status({ selected: 'deepseek', suspended: { provider: 'deepseek', reason: 'provider-pending-verification' } })
    expect(currentSelection('codex', suspended, 'deepseek')).toBe(false)
    const interrupted = status({ selected: null, interrupted: { provider: 'deepseek', reason: 'configuration-interrupted' } })
    expect(currentSelection('codex', interrupted, 'deepseek')).toBe(false)
    for (const broken of [suspended, interrupted]) {
      expect(selectionActionLabel(currentSelection('codex', broken, 'deepseek'))).toBe('启用')
    }
  })

  it('其他壳的选择不串到本壳；官方行同为配置口径', () => {
    const mixed: AiAccessStatus = { shells: {
      codex: { selected: null, officialAvailable: true, providerKeys: emptyKeys() },
      claude: { selected: 'deepseek', officialAvailable: true, providerKeys: { ...emptyKeys(), deepseek: true } },
      hermes: { selected: 'moonshot', officialAvailable: false, providerKeys: { ...emptyKeys(), moonshot: true } }
    } }
    expect(currentSelection('codex', mixed, 'deepseek')).toBe(false)
    expect(currentSelection('claude', mixed, 'deepseek')).toBe(true)
    expect(currentSelection('hermes', mixed, 'moonshot')).toBe(true)
    expect(currentSelection('claude', mixed, 'moonshot')).toBe(false)
    const official = status({ selected: 'official' })
    expect(currentSelection('codex', official, 'official')).toBe(true)
    expect(selectionActionLabel(currentSelection('codex', official, 'official'))).toBe('已配置')
    expect(currentSelection('codex', official, 'deepseek')).toBe(false)
  })

  it('三态证据只归它记录的那家：切来源后旧证据不挂到新来源行下', () => {
    const usage = [codexStage('deepseek', '2026-09-15T02:05:00.000Z')]
    expect(usageStageFor(usage, 'codex', 'deepseek')).toBeDefined()
    expect(usageStageFor(usage, 'codex', 'zhipu-api')).toBeUndefined()
    expect(usageStageFor(usage, 'claude', 'deepseek')).toBeUndefined()
  })
})
