import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {} }))
import { registerCodexUsageActions } from '../../app/main/actions/codex-usage'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { createUsageMonitor } from '../../app/main/codex-usage/monitor'
import { collectPreloadApis } from '../../app/preload/index'
import * as usageApi from '../../app/preload/api/codex-usage'

describe('受限用量桥', () => {
  it('实际 API 模块能进入产品 preload 注册表', () => {
    expect(collectPreloadApis({ usage: usageApi })).toHaveProperty('codexusage')
  })
  it('只允许无参读取，拒绝 token、命令参数与写操作', async () => {
    const registry = new BridgeRegistry()
    const read = vi.fn(async () => ({ account: { email: 'test@example.test', planType: 'plus' }, limits: { rateLimits: { primary: { usedPercent: 80 } } } }))
    registerCodexUsageActions(registry, createUsageMonitor(read))
    await expect(registry.execute('codexusage.refresh', { command: 'x', token: 'fixture' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
    await expect(registry.execute('codexusage.logout', undefined)).rejects.toMatchObject({ code: 'ACTION_NOT_FOUND' })
    expect(read).not.toHaveBeenCalled()
    const response = await registry.execute('codexusage.refresh', undefined) as { snapshot: string }
    expect(JSON.parse(response.snapshot)).toMatchObject({ status: 'ready', snapshot: { buckets: [{ primary: { remainingPercent: 20 } }] } })
    expect(response.snapshot).not.toContain('test@example.test')
  })
})
