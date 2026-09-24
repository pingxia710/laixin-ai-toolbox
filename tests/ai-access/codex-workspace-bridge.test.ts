import { describe, expect, it, vi } from 'vitest'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerCodexWorkspaceActions } from '../../app/main/actions/codex-workspaces'
import type { CodexWorkspaceService } from '../../app/main/ai-access/codex-workspaces'
import { collectPreloadApis } from '../../app/preload'
import * as codexWorkspacesApi from '../../app/preload/api/codex-workspaces'

describe('Codex 工作窗口受限桥', () => {
  it('预加载层只暴露固定来源和一次性 Key 输入动作', () => {
    expect(collectPreloadApis({ workspaces: codexWorkspacesApi })).toHaveProperty('codexworkspaces')
    expect(Object.keys(codexWorkspacesApi.api)).toEqual(['open'])
  })

  it('结果不回传 Key、线程 ID、本机路径或命令', async () => {
    const key = 'sk-bridge-fixture-key-1234567890'
    const service = { open: vi.fn(async () => ({ ok: true, source: 'deepseek' as const, code: 'opened' as const })) } as unknown as CodexWorkspaceService
    const registry = new BridgeRegistry()
    registerCodexWorkspaceActions(registry, service)

    const response = await registry.execute('codexworkspaces.open', { source: 'deepseek', key }) as { snapshot: string }
    expect(service.open).toHaveBeenCalledWith('deepseek', key)
    expect(JSON.parse(response.snapshot)).toEqual({ ok: true, source: 'deepseek', code: 'opened' })
    expect(response.snapshot).not.toContain(key)
    await expect(registry.execute('codexworkspaces.open', { source: 'deepseek', key, path: '/private' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  })
})
