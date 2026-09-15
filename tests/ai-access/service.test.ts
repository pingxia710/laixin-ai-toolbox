import { describe, expect, it, vi } from 'vitest'
import {
  AiAccessService,
  type AiAccessAdapter,
  type AiAccessState,
  type AiAccessStateStore
} from '../../app/main/ai-access/service'

function fixture(initial: AiAccessState = { version: 1, selected: {} }) {
  let state = initial
  const store: AiAccessStateStore = {
    read: async () => state,
    write: async (next) => { state = next }
  }
  const codex: AiAccessAdapter = {
    shell: 'codex',
    applyDeepSeek: vi.fn(async () => undefined),
    applyProvider: vi.fn(async () => undefined),
    activateOfficial: vi.fn(async () => undefined)
  }
  const claude: AiAccessAdapter = {
    shell: 'claude',
    applyDeepSeek: vi.fn(async () => undefined),
    applyProvider: vi.fn(async () => undefined),
    activateOfficial: vi.fn(async () => undefined)
  }
  const hermes: AiAccessAdapter = {
    shell: 'hermes',
    applyDeepSeek: vi.fn(async () => undefined),
    applyProvider: vi.fn(async () => undefined)
  }
  return { service: new AiAccessService(store, [codex, claude, hermes]), codex, claude, hermes, state: () => state }
}

describe('AI 接入核心', () => {
  it('首次读取隔离坏的接入存储时，第一份状态就带固定恢复提示', async () => {
    let note: string | undefined
    let firstRead = true
    const store: AiAccessStateStore = {
      read: async () => {
        if (firstRead) {
          firstRead = false
          note = '保存的 Key 已失效，请重新添加。'
        }
        return { version: 1, selected: {} }
      },
      write: async () => undefined,
      consumeCorruptionNote: () => {
        const current = note
        note = undefined
        return current
      }
    }
    const service = new AiAccessService(store, [
      { shell: 'codex', applyDeepSeek: async () => undefined },
      { shell: 'claude', applyDeepSeek: async () => undefined },
      { shell: 'hermes', applyDeepSeek: async () => undefined }
    ])

    await expect(service.status()).resolves.toMatchObject({ storageNote: '保存的 Key 已失效，请重新添加。' })
    await expect(service.status()).resolves.not.toHaveProperty('storageNote')
    await service.stop()
  })

  it('产品 Key 各自加密保存，并写入已完成原生验收的对应壳', async () => {
    const f = fixture()
    const zhipuKey = 'zhipu-toolbox-fixture-key-1234567890'
    const kimiKey = 'sk-kimi-toolbox-fixture-key-1234567890'
    await f.service.saveProviderKey('codex', 'zhipu', zhipuKey)
    await f.service.saveProviderKey('claude', 'zhipu', zhipuKey)
    await f.service.saveProviderKey('hermes', 'kimi', kimiKey)
    await f.service.useProvider('codex', 'zhipu')
    await f.service.useProvider('claude', 'zhipu')
    await f.service.useProvider('hermes', 'kimi')

    expect(f.codex.applyProvider).toHaveBeenCalledWith('zhipu', zhipuKey)
    expect(f.claude.applyProvider).toHaveBeenCalledWith('zhipu', zhipuKey)
    expect(f.hermes.applyProvider).toHaveBeenCalledWith('kimi', kimiKey)
    expect(f.state()).toMatchObject({ shellKeys: { codex: { zhipu: zhipuKey }, claude: { zhipu: zhipuKey }, hermes: { kimi: kimiKey } }, selected: { codex: 'zhipu', claude: 'zhipu', hermes: 'kimi' } })
    expect((await f.service.status()).shells.codex.providerKeys.zhipu).toBe(true)
  })

  it('三个壳分别保存自己的 DeepSeek Key，任何对外状态都不含 Key', async () => {
    const f = fixture()
    const key = 'sk-toolbox-fixture-key-1234567890'

    await f.service.saveProviderKey('codex', 'deepseek', key)
    await f.service.useProvider('codex', 'deepseek')
    await f.service.saveProviderKey('claude', 'deepseek', key)
    await f.service.useProvider('claude', 'deepseek')
    await f.service.saveProviderKey('hermes', 'deepseek', key)
    await f.service.useProvider('hermes', 'deepseek')

    expect(f.codex.applyDeepSeek).toHaveBeenCalledWith(key)
    expect(f.claude.applyDeepSeek).toHaveBeenCalledWith(key)
    expect(f.hermes.applyDeepSeek).toHaveBeenCalledWith(key)
    expect(f.state()).toMatchObject({ shellKeys: { codex: { deepseek: key }, claude: { deepseek: key }, hermes: { deepseek: key } }, selected: { codex: 'deepseek', claude: 'deepseek', hermes: 'deepseek' } })
    expect(JSON.stringify(await f.service.status())).not.toContain(key)
  })

  it('切换官方套餐不删除 DeepSeek Key；Hermes 的解除走解除接管动作而非冒充官方套餐', async () => {
    const f = fixture()
    const key = 'sk-toolbox-fixture-key-1234567890'
    await f.service.saveProviderKey('codex', 'deepseek', key)
    await f.service.useProvider('codex', 'deepseek')
    await f.service.useOfficial('codex')

    expect(f.codex.activateOfficial).toHaveBeenCalledOnce()
    expect(f.state()).toMatchObject({ shellKeys: { codex: { deepseek: key } }, selected: { codex: 'official' } })
    // 没有解除钩子的适配器仍然如实报不支持；Hermes 生产适配器带解除钩子后，
    // 解除走的是 deactivateToolboxConnection（解除工具箱接管），⛔ 不是假装它有官方套餐。
    await expect(f.service.useOfficial('hermes')).rejects.toThrow('AI_ACCESS_OFFICIAL_UNSUPPORTED')
    f.hermes.deactivateToolboxConnection = vi.fn(async () => undefined)
    await f.service.useOfficial('hermes')
    expect(f.hermes.deactivateToolboxConnection).toHaveBeenCalledOnce()
    expect(f.state().selected.hermes).toBe('official')
    expect(f.state().shellKeys?.codex?.deepseek).toBe(key)
  })

  it('壳配置失败时不把当前使用方式伪装成已切换', async () => {
    const f = fixture()
    await f.service.saveProviderKey('claude', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    vi.mocked(f.claude.applyDeepSeek).mockRejectedValueOnce(new Error('private failure detail'))

    await expect(f.service.useProvider('claude', 'deepseek')).rejects.toThrow('AI_ACCESS_APPLY_FAILED')
    expect(f.state().selected.claude).toBeUndefined()
    expect(f.state().shellKeys?.claude?.deepseek).toBe('sk-toolbox-fixture-key-1234567890')
  })

  it('缺 Key 与不合法 Key 都不会调用壳配置', async () => {
    const f = fixture()
    await expect(f.service.useProvider('codex', 'deepseek')).rejects.toThrow('AI_ACCESS_DEEPSEEK_KEY_MISSING')
    await expect(f.service.saveProviderKey('codex', 'deepseek', 'too-short')).rejects.toThrow('AI_ACCESS_DEEPSEEK_KEY_INVALID')
    expect(f.codex.applyDeepSeek).not.toHaveBeenCalled()
  })

  it('官方授权完成与另一个壳同时切换时，两个选择和 Key 都保留', async () => {
    const f = fixture()
    const key = 'sk-toolbox-fixture-key-1234567890'
    await f.service.saveProviderKey('claude', 'deepseek', key)
    let release!: () => void
    vi.mocked(f.codex.activateOfficial!).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const official = f.service.useOfficial('codex')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const deepseek = f.service.useProvider('claude', 'deepseek')
    await Promise.resolve()
    release()
    await Promise.all([official, deepseek])
    expect(f.state()).toMatchObject({ shellKeys: { claude: { deepseek: key } }, selected: { codex: 'official', claude: 'deepseek' } })
  })

  it('恢复官方失败保留原选择，后续写操作不会被失败的队列阻塞', async () => {
    const f = fixture({ version: 1, deepseekKey: 'sk-toolbox-fixture-key-1234567890', selected: { codex: 'deepseek' } })
    vi.mocked(f.codex.activateOfficial!).mockRejectedValueOnce(new Error('AI_ACCESS_CONFIG_UNMANAGED'))
    await expect(f.service.useOfficial('codex')).rejects.toThrow('AI_ACCESS_APPLY_FAILED')
    await f.service.saveProviderKey('claude', 'deepseek', 'sk-toolbox-fixture-claude-1234567890')
    await f.service.useProvider('claude', 'deepseek')
    expect(f.state().selected).toEqual({ codex: 'deepseek', claude: 'deepseek' })
  })
})
