import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { createGatedCodexUsageRead, registerCodexUsageActions } from '../../app/main/actions/codex-usage'
import { createUsageMonitor } from '../../app/main/codex-usage/monitor'
import type { CodexCommand } from '../../app/main/codex-usage/runtime'
import { AddedOfficialAccounts } from '../../app/main/ai-access/added-accounts'
import { codexAccountKey } from '../../app/main/codex-usage/normalize'

const fixtureAccount = { type: 'chatgpt', email: 'demo@example.test', planType: 'plus' }
const fixtureLimits = { rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 27 } } } }
type ReadOptions = { cwd: string; signal: AbortSignal; addedAccountKey: string }

describe('codexusage 主进程闸口', () => {
  it('登记表为空时底层读取一次都不发生（not-added）；登记后同一 action 才真正读取', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-usage-gate-'))
    try {
      const store = new AddedOfficialAccounts(join(directory, 'official-accounts.json'))
      const read = vi.fn<(commands: readonly CodexCommand[], options: ReadOptions) => Promise<{ account: typeof fixtureAccount; limits: typeof fixtureLimits }>>(
        async () => ({ account: fixtureAccount, limits: fixtureLimits }))
      let clock = 1_000
      const gatedRead = createGatedCodexUsageRead({
        addedKey: () => store.key('codex'),
        commands: async () => [{ executable: 'codex-under-test', args: [] }],
        cwd: tmpdir(),
        read
      })
      const registry = new BridgeRegistry()
      registerCodexUsageActions(registry, createUsageMonitor(gatedRead, () => clock))

      const before = JSON.parse(((await registry.execute('codexusage.refresh', undefined)) as { snapshot: string }).snapshot)
      expect(before.status).toBe('not-added')
      expect(before.snapshot).toBeNull()
      expect(read).not.toHaveBeenCalled()

      await store.mark('codex', codexAccountKey(fixtureAccount))
      clock += 31_000
      const after = JSON.parse(((await registry.execute('codexusage.refresh', undefined)) as { snapshot: string }).snapshot)
      expect(after.status).toBe('ready')
      expect(after.snapshot.accountKey).toBe(codexAccountKey(fixtureAccount))
      expect(read).toHaveBeenCalledTimes(1)
      expect(read.mock.calls[0]?.[1]?.addedAccountKey).toBe(codexAccountKey(fixtureAccount))
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
