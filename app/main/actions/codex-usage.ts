import { app } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { readCodexUsageForAddedAccount, UsageReadError } from '../codex-usage/client'
import { createUsageMonitor } from '../codex-usage/monitor'
import type { CodexCommand } from '../codex-usage/runtime'
import { sharedAddedOfficialAccounts } from '../ai-access/added-accounts'
import { shellInventory } from '../shells/context'
import { trustedCliExecutables } from '../shells/inventory'

export function registerCodexUsageActions(registry: BridgeRegistry, monitor: ReturnType<typeof createUsageMonitor>): void {
  for (const method of ['last', 'refresh'] as const) {
    registry.registerAction({
      name: `codexusage.${method}`,
      paramsSchema: schema.undefined(),
      resultSchema: schema.object({ snapshot: schema.string({ maxLength: 100_000 }) }),
      handler: async () => ({ snapshot: JSON.stringify(await monitor[method]()) })
    })
  }
  registry.registerAction({
    name: 'codexusage.refreshForAccount', paramsSchema: schema.object({ accountKey: schema.string({ maxLength: 64 }) }),
    resultSchema: schema.object({ snapshot: schema.string({ maxLength: 100_000 }) }),
    handler: async params => {
      const { accountKey } = params as { accountKey: string }
      if (!/^[a-f0-9]{64}$/.test(accountKey)) throw new Error('ACCOUNT_KEY_INVALID')
      return { snapshot: JSON.stringify(await monitor.refresh(accountKey)) }
    }
  })
  registry.registerShutdownHook('codex-usage', () => monitor.dispose())
}

/** 闸口的登记表与候选来源；结构化接口让测试可以直接喂临时实例与探针。 */
export interface GatedCodexUsageReadDeps {
  addedKey: () => Promise<string | null>
  commands: () => Promise<readonly CodexCommand[]>
  cwd: string
  read?: (commands: readonly CodexCommand[], options: { cwd: string; signal: AbortSignal; addedAccountKey: string }) => Promise<{
    account: Record<string, unknown>
    limits: unknown
  }>
}

/**
 * 用量读取的主进程闸口：登记表为空时抛 not-added，⛔ 连候选枚举都不做——
 * 更不能启动任何一个 codex 二进制（判据：没登录就不该扫本机账号）。
 */
export function createGatedCodexUsageRead(deps: GatedCodexUsageReadDeps): (signal: AbortSignal) => Promise<{
  account: Record<string, unknown>
  limits: unknown
}> {
  const read = deps.read ?? readCodexUsageForAddedAccount
  return async (signal) => {
    const addedAccountKey = await deps.addedKey()
    if (addedAccountKey === null) throw new UsageReadError('not-added')
    const commands = await deps.commands()
    if (commands.length === 0) throw new UsageReadError('not-installed')
    return read(commands, { cwd: deps.cwd, signal, addedAccountKey })
  }
}

export function registerActions(registry: BridgeRegistry): void {
  const home = app.getPath('home')
  const addedAccounts = sharedAddedOfficialAccounts()
  const read = createGatedCodexUsageRead({
    addedKey: () => addedAccounts.key('codex'),
    commands: async () => {
      const executables = await trustedCliExecutables('codex', process.platform, home, shellInventory().environment())
      return executables.map(executable => ({ executable, args: ['app-server', '--listen', 'stdio://'] as const }))
    },
    cwd: home
  })
  registerCodexUsageActions(registry, createUsageMonitor(read))
}
