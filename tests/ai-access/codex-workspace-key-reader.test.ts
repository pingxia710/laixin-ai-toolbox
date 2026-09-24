import { describe, expect, it, vi } from 'vitest'
import { codexProviderKeyArgument, emitCodexProviderKey, readCodexProviderKeyRequest } from '../../app/main/ai-access/codex-workspace-key-reader'

describe('Codex command auth 取钥入口', () => {
  it('只接受固定参数和三家开放平台，不把官方账号当 API Key 来源', () => {
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'deepseek'])).toBe('deepseek')
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'moonshot'])).toBe('moonshot')
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'zhipu-api'])).toBe('zhipu-api')
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'official'])).toBeUndefined()
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'other'])).toBeUndefined()
    expect(readCodexProviderKeyRequest(['/toolbox', codexProviderKeyArgument, 'deepseek', codexProviderKeyArgument, 'moonshot'])).toBeUndefined()
  })

  it('从现有加密状态只输出指定 Key；缺失和损坏状态保持空输出', async () => {
    const write = vi.fn()
    const key = 'sk-command-auth-fixture-1234567890'
    const store = { read: vi.fn(async () => ({ version: 1 as const, selected: {}, shellKeys: { codex: { deepseek: key } } })), write: vi.fn() }
    await expect(emitCodexProviderKey('deepseek', store, write)).resolves.toBe(true)
    expect(write).toHaveBeenCalledWith(key)
    write.mockClear()
    await expect(emitCodexProviderKey('moonshot', store, write)).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
