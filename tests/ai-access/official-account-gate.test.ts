import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerOfficialAccountActions } from '../../app/main/actions/official-account'
import { AddedOfficialAccounts } from '../../app/main/ai-access/added-accounts'
import type { OfficialAccount } from '../../app/shared/official-account'

const keyA = 'a'.repeat(64)
const keyB = 'b'.repeat(64)
const signedIn = (key: string): OfficialAccount => ({ state: 'signed-in', accountKey: key, accountLabel: 'de***@example.test', plan: 'plus' })
const readSnapshot = async (registry: BridgeRegistry, shell: string): Promise<OfficialAccount> =>
  JSON.parse(((await registry.execute('officialaccount.read', { shell })) as { snapshot: string }).snapshot) as OfficialAccount

describe('officialaccount.read 主进程闸口', () => {
  it('登记表为空时不扫本机：底层读取一次都不被调；登记后同一 action 才真正读取', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'official-account-gate-'))
    try {
      const store = new AddedOfficialAccounts(join(directory, 'official-accounts.json'))
      const read = vi.fn(async () => signedIn(keyA))
      const registry = new BridgeRegistry()
      registerOfficialAccountActions(registry, read, store)

      expect(await readSnapshot(registry, 'codex')).toEqual({ state: 'signed-out', accountLabel: null, plan: null })
      expect(read).not.toHaveBeenCalled()

      await store.mark('codex', keyA)
      expect(await readSnapshot(registry, 'codex')).toEqual(signedIn(keyA))
      expect(read).toHaveBeenCalledTimes(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('claude 走同一道闸口：未登记时 claude 的底层读取同样一次都不调', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'official-account-gate-claude-'))
    try {
      const store = new AddedOfficialAccounts(join(directory, 'official-accounts.json'))
      const read = vi.fn(async () => signedIn(keyA))
      const registry = new BridgeRegistry()
      registerOfficialAccountActions(registry, read, store)

      await readSnapshot(registry, 'claude')
      expect(read).not.toHaveBeenCalled()
      await store.mark('claude', keyA)
      await readSnapshot(registry, 'claude')
      expect(read).toHaveBeenCalledTimes(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('登记指纹与机器账号不一致时按未登录引导，机器账号身份不外泄', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'official-account-gate-mismatch-'))
    try {
      const store = new AddedOfficialAccounts(join(directory, 'official-accounts.json'))
      const read = vi.fn(async () => signedIn(keyB))
      const registry = new BridgeRegistry()
      registerOfficialAccountActions(registry, read, store)
      await store.mark('codex', keyA)

      const snapshot = await readSnapshot(registry, 'codex')
      expect(snapshot).toEqual({ state: 'signed-out', accountLabel: null, plan: null })
      expect(snapshot.accountKey).toBeUndefined()
      expect(read).toHaveBeenCalledTimes(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

