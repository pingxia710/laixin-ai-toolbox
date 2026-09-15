import { describe, expect, it, vi } from 'vitest'
import { registerAiAccessActions } from '../../app/main/actions/ai-access'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { AiAccessService, aiAccessShells, type AiAccessState } from '../../app/main/ai-access/service'

describe('项目配置目标主进程动作', () => {
  it('Codex 项目目录动作会在服务端拒绝，不打开选择器、不写入状态', async () => {
    let state: AiAccessState = { version: 1, selected: { codex: 'official' } }
    const write = vi.fn(async (next: AiAccessState) => { state = next })
    const selectedProject = vi.fn(async () => {
      throw new Error('picker must not run for Codex')
    })
    const service = new AiAccessService(
      { read: async () => state, write },
      aiAccessShells.map(shell => ({
        shell,
        applyDeepSeek: async () => undefined,
        ...(shell === 'codex' ? { selectConfigurationProject: selectedProject } : {})
      }))
    )
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, async () => '/customer/selected-project')

    await expect(registry.execute('aiaccess.selectConfigurationProject', { shell: 'codex' }))
      .rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(registry.execute('aiaccess.selectConfigurationTarget', { shell: 'codex', scope: 'project' }))
      .rejects.toMatchObject({ code: 'ACTION_FAILED' })
    expect(selectedProject).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(JSON.stringify(state)).not.toContain('/customer/selected-project')
    await service.stop()
  })

  it('首次读取历史 Codex project scope 后自动迁移为用户级，Claude 项目决定保留', async () => {
    let state: AiAccessState = {
      version: 1,
      configurationTargetScopes: { codex: 'project', claude: 'project' },
      selected: {}
    }
    const write = vi.fn(async (next: AiAccessState) => { state = next })
    const service = new AiAccessService(
      { read: async () => state, write },
      aiAccessShells.map(shell => ({
        shell,
        applyDeepSeek: async () => undefined,
        ...(shell === 'codex' ? {
          configurationTargetStatus: async () => ({ shell: 'codex' as const, scope: 'user' as const, override: 'none' as const, writable: true as const })
        } : {})
      }))
    )

    const status = await service.status()

    expect(write).toHaveBeenCalledOnce()
    expect(state.configurationTargetScopes).toEqual({ claude: 'project' })
    expect(status.configurationTargets?.codex).toEqual({ shell: 'codex', scope: 'user', override: 'none', writable: true })
    await service.stop()
  })
})
