import { describe, expect, it, vi } from 'vitest'
import { cleanupAiRouter } from '../../app/main/ai-access/router-cleanup'
import type { AiAccessState } from '../../app/main/ai-access/service'

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
})
