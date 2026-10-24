import { describe, expect, it, vi } from 'vitest'
import { AiAccessService, aiAccessShells, type AiAccessAdapter, type AiAccessState } from '../../app/main/ai-access/service'

type UpgradeState = AiAccessState & {
  readonly migrations?: { readonly api15rD?: 1; readonly [key: string]: unknown }
}

function serviceFixture(initial: AiAccessState) {
  let state = initial
  const writes: AiAccessState[] = []
  const adapters: AiAccessAdapter[] = aiAccessShells.map(shell => ({
    shell,
    applyDeepSeek: vi.fn(async () => undefined)
  }))
  const store = {
    read: async () => state,
    write: vi.fn(async (next: AiAccessState) => { writes.push(next); state = next })
  }
  return { service: new AiAccessService(store, adapters), store, writes, state: () => state as UpgradeState }
}

describe('API-15R-D 状态迁移', () => {
  it('0.5.20 单模型 Key 保留为已安全保存，但不自动进入多模型池，且重复启动幂等', async () => {
    const key = 'sk-fixture-upgrade-deepseek-0123456789'
    const f = serviceFixture({
      version: 1,
      selected: { codex: 'deepseek' },
      shellKeys: { codex: { deepseek: key } }
    })

    await f.service.initialize()
    const first = await f.service.status()
    expect(first.shells.codex.providerKeys.deepseek).toBe(true)
    expect(first.codexMultiModel).toEqual({ mode: 'single', models: [] })
    expect(f.state()).toMatchObject({
      shellKeys: { codex: { deepseek: key } },
      codexMode: 'single',
      codexMultiModelPool: [],
      migrations: { api15rD: 1 }
    })
    expect(f.writes).toHaveLength(1)

    await f.service.initialize()
    await f.service.status()
    expect(f.writes).toHaveLength(1)
  })

  it('迁移写入失败时不清空原 Key，并失败关闭', async () => {
    const original: AiAccessState = {
      version: 1,
      selected: { codex: 'deepseek' },
      shellKeys: { codex: { deepseek: 'sk-fixture-original-deepseek-0123456789' } }
    }
    const adapters: AiAccessAdapter[] = aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined }))
    const store = { read: async () => original, write: vi.fn(async () => { throw new Error('fixture migration write failure') }) }
    const service = new AiAccessService(store, adapters)

    await expect(service.initialize()).resolves.toBeUndefined()
    await expect(service.serviceStatus()).resolves.toMatchObject({ startupError: 'configuration_failed' })
    expect(original).toEqual({
      version: 1,
      selected: { codex: 'deepseek' },
      shellKeys: { codex: { deepseek: 'sk-fixture-original-deepseek-0123456789' } }
    })
  })

  it('首次迁移写失败后，下一次保存 Key 先补齐迁移标记再提交 Key', async () => {
    const original: AiAccessState = {
      version: 1,
      selected: { codex: 'deepseek' },
      shellKeys: { codex: { deepseek: 'sk-fixture-recovery-original-0123456789' } }
    }
    let state = original
    let failMigration = true
    const writes: AiAccessState[] = []
    const adapters: AiAccessAdapter[] = aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined }))
    const store = {
      read: async () => state,
      write: vi.fn(async (next: AiAccessState) => {
        if (failMigration) { failMigration = false; throw new Error('fixture first migration write failure') }
        writes.push(next)
        state = next
      })
    }
    const service = new AiAccessService(store, adapters)

    await service.initialize()
    await expect(service.serviceStatus()).resolves.toMatchObject({ startupError: 'configuration_failed' })
    await service.saveProviderKey('claude', 'deepseek', 'sk-fixture-recovery-claude-0123456789')

    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ migrations: { api15rD: 1 } })
    expect(writes[0].shellKeys?.claude?.deepseek).toBeUndefined()
    expect(writes[1]).toMatchObject({ migrations: { api15rD: 1 }, shellKeys: { claude: { deepseek: 'sk-fixture-recovery-claude-0123456789' } } })
    expect(state.migrations).toMatchObject({ api15rD: 1 })
    await expect(service.serviceStatus()).resolves.not.toHaveProperty('startupError')
  })

  it('迁移持续写失败时拒绝保存，原 Key 和原字节不变', async () => {
    const original = {
      version: 1,
      selected: { codex: 'deepseek' },
      shellKeys: { codex: { deepseek: 'sk-fixture-persistent-original-0123456789' } },
      unknown: { preserve: 'bytes' }
    } as unknown as AiAccessState
    const before = JSON.stringify(original)
    const adapters: AiAccessAdapter[] = aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined }))
    const store = { read: async () => original, write: vi.fn(async () => { throw new Error('fixture persistent write failure') }) }
    const service = new AiAccessService(store, adapters)

    await service.initialize()
    await expect(service.saveProviderKey('claude', 'deepseek', 'sk-fixture-persistent-claude-0123456789'))
      .rejects.toThrow('AI_ACCESS_STATE_MIGRATION_FAILED')

    expect(JSON.stringify(original)).toBe(before)
    expect(original.shellKeys?.codex?.deepseek).toBe('sk-fixture-persistent-original-0123456789')
    expect(original.shellKeys?.claude?.deepseek).toBeUndefined()
  })

  it('恢复迁移时逐字保留未知字段和未来迁移字段', async () => {
    const initial = {
      version: 1,
      selected: {},
      shellKeys: { codex: { deepseek: 'sk-fixture-future-recovery-0123456789' } },
      migrations: { futureMigration: { keep: 'verbatim' } },
      futureDField: { keep: 'verbatim' }
    } as unknown as AiAccessState
    let state = initial
    let failMigration = true
    const writes: AiAccessState[] = []
    const adapters: AiAccessAdapter[] = aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined }))
    const store = {
      read: async () => state,
      write: vi.fn(async (next: AiAccessState) => {
        if (failMigration) { failMigration = false; throw new Error('fixture migration write failure') }
        writes.push(next)
        state = next
      })
    }
    const service = new AiAccessService(store, adapters)

    await service.initialize()
    await service.saveProviderKey('claude', 'deepseek', 'sk-fixture-future-recovery-claude-0123456789')

    expect(writes[0]).toMatchObject({ migrations: { api15rD: 1, futureMigration: { keep: 'verbatim' } }, futureDField: { keep: 'verbatim' } })
    expect((state as unknown as { futureDField: unknown }).futureDField).toEqual({ keep: 'verbatim' })
    expect((state.migrations as unknown as { futureMigration: unknown }).futureMigration).toEqual({ keep: 'verbatim' })
  })

  it('不认识的迁移标记失败关闭，不覆盖原状态', async () => {
    const future = {
      version: 1,
      selected: {},
      shellKeys: { codex: { deepseek: 'sk-fixture-future-deepseek-0123456789' } },
      migrations: { api15rD: 2 }
    } as unknown as AiAccessState
    const f = serviceFixture(future)

    await expect(f.service.initialize()).resolves.toBeUndefined()
    await expect(f.service.status()).rejects.toThrow('AI_ACCESS_STORAGE_INVALID')
    expect(f.store.write).not.toHaveBeenCalled()
  })

  it('回退可见的 version 仍为 1，旧版忽略的新字段在后续写入中不丢失', async () => {
    const initial = {
      version: 1,
      selected: {},
      shellKeys: { codex: { deepseek: 'sk-fixture-rollback-deepseek-0123456789' } },
      codexMode: 'single',
      codexMultiModelPool: [],
      migrations: { api15rD: 1, futureMigration: { keep: 'verbatim' } },
      futureDField: { keep: 'verbatim' }
    } as unknown as AiAccessState
    const f = serviceFixture(initial)

    await f.service.saveProviderKey('claude', 'deepseek', 'sk-fixture-rollback-claude-0123456789')

    expect(f.state().version).toBe(1)
    expect((f.state() as unknown as { futureDField: unknown }).futureDField).toEqual({ keep: 'verbatim' })
    expect((f.state().migrations as unknown as { futureMigration: unknown }).futureMigration).toEqual({ keep: 'verbatim' })
    expect(f.state().shellKeys?.codex?.deepseek).toBe('sk-fixture-rollback-deepseek-0123456789')
  })
})
