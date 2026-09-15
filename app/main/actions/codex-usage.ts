import { app } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { readCodexUsage, UsageReadError } from '../codex-usage/client'
import { createUsageMonitor } from '../codex-usage/monitor'
import { shellInventory } from '../shells/context'
import { trustedCliExecutable } from '../shells/inventory'

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

export function registerActions(registry: BridgeRegistry): void {
  const home = app.getPath('home')
  registerCodexUsageActions(registry, createUsageMonitor(async (signal) => {
    const executable = await trustedCliExecutable('codex', process.platform, home, shellInventory().environment())
    if (executable === undefined) throw new UsageReadError('not-installed')
    const command = { executable, args: ['app-server', '--listen', 'stdio://'] }
    return readCodexUsage(command, { cwd: home, signal })
  }))
}
