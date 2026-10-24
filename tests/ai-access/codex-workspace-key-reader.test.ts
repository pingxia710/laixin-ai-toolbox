import { describe, expect, it, vi } from 'vitest'
import { codexProviderKeyArgument, emitCodexProviderKey, readCodexProviderKeyRequest } from '../../app/main/ai-access/codex-workspace-key-reader'
import type { AiAccessState } from '../../app/main/ai-access/service'

const localToken = 'a'.repeat(64)
const upstreamKey = 'sk-private-upstream-key-0123456789'
const multiState: AiAccessState = {
  version: 1,
  selected: {},
  codexMultiRelay: { port: 43123, identitySecret: 'b'.repeat(64) },
  shellKeys: { codex: { deepseek: upstreamKey } },
  codexMode: 'multi',
  codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }]
}

describe('Codex laixin-multi command auth', () => {
  it('只接受固定 multi 与历史固定来源参数，拒绝官方和未知参数', () => {
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'multi'])).toBe('multi')
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'deepseek'])).toBe('deepseek')
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'moonshot'])).toBe('moonshot')
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'zhipu-api'])).toBe('zhipu-api')
    for (const source of ['official', 'other']) {
      expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, source])).toBeUndefined()
    }
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'multi', codexProviderKeyArgument, 'multi'])).toBeUndefined()
  })

  it('只输出本机网关客户端令牌，绝不输出任何上游 Key', async () => {
    const write = vi.fn()
    const store = { read: vi.fn(async () => multiState), write: vi.fn() }
    await expect(emitCodexProviderKey('multi', store, write, { ensureReady: async () => ({
      baseUrl: 'http://127.0.0.1:43123', runtime: { pid: 123, bootId: 'c'.repeat(32), port: 43123, token: localToken }
    }) })).resolves.toBe(true)
    expect(write).toHaveBeenCalledWith(localToken)
    expect(JSON.stringify(write.mock.calls)).not.toContain(upstreamKey)
    expect(store.write).not.toHaveBeenCalled()
  })

  it('历史固定来源只读取该来源已保存的 Codex Key，不要求或写入多模型池', async () => {
    const write = vi.fn()
    const legacyState: AiAccessState = {
      version: 1,
      selected: { codex: 'official' },
      shellKeys: { codex: { deepseek: upstreamKey } },
      codexMode: 'single',
      codexMultiModelPool: []
    }
    const store = { read: vi.fn(async () => legacyState), write: vi.fn() }

    await expect(emitCodexProviderKey('deepseek', store, write, { ensureReady: async () => false })).resolves.toBe(true)
    expect(write).toHaveBeenCalledWith(upstreamKey)
    expect(store.write).not.toHaveBeenCalled()
    expect(legacyState.codexMultiModelPool).toEqual([])
  })

  it('缺少池、令牌或错误参数保持空输出', async () => {
    const write = vi.fn()
    const emptyPool = { ...multiState, codexMultiModelPool: undefined }
    await expect(emitCodexProviderKey('multi', { read: async () => emptyPool }, write, { ensureReady: async () => false })).resolves.toBe(false)
    await expect(emitCodexProviderKey('multi', { read: async () => ({ ...multiState, codexMultiRelay: undefined }) }, write, { ensureReady: async () => false })).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
