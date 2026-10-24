import { describe, expect, it, vi } from 'vitest'
import { cleanupAiRouter } from '../../app/main/ai-access/router-cleanup'
import type { AiAccessState } from '../../app/main/ai-access/service'
import { aiAccessShells } from '../../app/main/ai-access/service'

const state: AiAccessState = { version: 1, selected: {}, migrations: { api15rD: 1 } }

describe('AI router 解除/卸载清理', () => {
  it('只调用经验证的 AI router stop，不改写状态或 Key', async () => {
    const write = vi.fn(async () => undefined)
    const stop = vi.fn(async () => true)
    await cleanupAiRouter('/fixture/no-runtime', { executable: '/fixture/toolbox', logDir: '/fixture/logs' }, {
      store: { read: async () => state, write }, controller: { stop }
    })
    expect(stop).toHaveBeenCalledWith(state)
    expect(write).not.toHaveBeenCalled()
  })

  it('旧 owner 无法证明已停止时失败关闭', async () => {
    await expect(cleanupAiRouter('/fixture/no-runtime', { executable: '/fixture/toolbox', logDir: '/fixture/logs' }, {
      store: { read: async () => state, write: async () => undefined }, controller: { stop: async () => false }
    })).rejects.toThrow('AI_ROUTER_CLEANUP_FAILED')
  })

  it('卸载先确认路由已停，再解除三壳本机地址，保存的 Key 和模型池保留', async () => {
    let stored: AiAccessState = { version: 1, selected: { codex: 'deepseek', claude: 'deepseek', hermes: 'deepseek' },
      relayShells: [...aiAccessShells], shellKeys: { codex: { deepseek: 'sk-fixture-cleanup-0123456789' } } }
    const order: string[] = []
    const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined,
      captureConnection: async () => async () => { order.push(`rollback:${shell}`) },
      deactivateToolboxConnection: async () => { order.push(`detach:${shell}`) } }))
    await cleanupAiRouter('/fixture/no-runtime', { executable: '/fixture/toolbox', logDir: '/fixture/logs' }, {
      store: { read: async () => stored, write: async next => { stored = next; order.push('state') } },
      controller: { stop: async () => { order.push('stop'); return true } }, adapters
    })
    expect(order).toEqual(['stop', 'detach:codex', 'detach:claude', 'detach:hermes', 'state'])
    expect(stored.relayShells).toEqual([])
    expect(stored.selected.hermes).toBe('official')
    expect(stored.shellKeys?.codex?.deepseek).toBe('sk-fixture-cleanup-0123456789')
  })

  it('卸载状态写入失败恢复已经解除的配置，不能当成卸载成功', async () => {
    const order: string[] = []
    const stored: AiAccessState = { version: 1, selected: { codex: 'deepseek' }, relayShells: ['codex'] }
    const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined,
      captureConnection: async () => async () => { order.push('rollback') },
      deactivateToolboxConnection: async () => { order.push('detach') } }))
    await expect(cleanupAiRouter('/fixture/no-runtime', { executable: '/fixture/toolbox', logDir: '/fixture/logs' }, {
      store: { read: async () => stored, write: async () => { throw new Error('fixture write failed') } },
      controller: { stop: async () => true, ensureReady: async current => {
        expect(current).toBe(stored)
        order.push('restart')
        return { runtime: { pid: 123, bootId: 'b'.repeat(32), port: 43211, token: 'a'.repeat(64) }, baseUrl: 'http://127.0.0.1:43211' }
      } }, adapters
    })).rejects.toThrow('AI_ROUTER_CONFIGURATION_CLEANUP_FAILED')
    expect(order).toEqual(['detach', 'rollback', 'restart'])
    expect(stored.selected.codex).toBe('deepseek')
  })

  it('解除前恢复客户选择的项目配置位置，不能默认解除用户目录', async () => {
    const stored: AiAccessState = { version: 1, selected: { claude: 'deepseek' }, relayShells: ['claude'],
      configurationTargetScopes: { claude: 'project' } }
    const order: string[] = []
    let selected = 'user'
    const adapter = { shell: 'claude' as const, applyDeepSeek: async () => undefined,
      selectConfigurationTarget: async (scope: 'user' | 'project') => {
        selected = scope
        order.push(`select:${scope}`)
        return { shell: 'claude' as const, scope, override: 'none' as const, writable: true }
      },
      captureConnection: async () => { order.push(`capture:${selected}`); return async () => undefined },
      deactivateToolboxConnection: async () => { order.push(`detach:${selected}`) } }
    await cleanupAiRouter('/fixture/no-runtime', { executable: '/fixture/toolbox', logDir: '/fixture/logs' }, {
      store: { read: async () => stored, write: async () => undefined }, controller: { stop: async () => true }, adapters: [adapter]
    })
    expect(order).toEqual(['select:project', 'capture:project', 'detach:project'])
  })

  it('多模型目录解除后 Codex 回到官方选择，保存的池和 Key 保留', async () => {
    let stored: AiAccessState = { version: 1, selected: { codex: 'deepseek' }, codexMode: 'multi',
      codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }],
      shellKeys: { codex: { deepseek: 'sk-fixture-cleanup-0123456789' } } }
    await cleanupAiRouter('/fixture/no-runtime', { executable: '/fixture/toolbox', logDir: '/fixture/logs' }, {
      store: { read: async () => stored, write: async next => { stored = next } }, controller: { stop: async () => true },
      adapters: [{ shell: 'codex', applyDeepSeek: async () => undefined, codexOfficialLoginRoot: async () => '/fixture/codex' }],
      deactivateMulti: async (_home, commit) => commit()
    })
    expect(stored.selected.codex).toBe('official')
    expect(stored.codexMultiModelPool).toHaveLength(1)
    expect(stored.shellKeys?.codex?.deepseek).toBe('sk-fixture-cleanup-0123456789')
  })
})
