import { app } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { readClaudeOfficialAccount, readCodexOfficialAccount } from '../ai-access/official-account'
import { shellInventory } from '../shells/context'
import { trustedCliExecutable } from '../shells/inventory'
import type { OfficialAccount } from '../../shared/official-account'

export function registerOfficialAccountActions(registry: BridgeRegistry, read: (shell: 'codex' | 'claude') => Promise<OfficialAccount>): void {
  registry.registerAction({
    name: 'officialaccount.read', paramsSchema: schema.object({ shell: schema.string({ maxLength: 20 }) }),
    resultSchema: schema.object({ snapshot: schema.string({ maxLength: 2000 }) }),
    handler: async params => {
      const { shell } = params as { shell: string }
      if (shell !== 'codex' && shell !== 'claude') throw new Error('OFFICIAL_ACCOUNT_SHELL_INVALID')
      return { snapshot: JSON.stringify(await read(shell)) }
    }
  })
}

export function registerActions(registry: BridgeRegistry): void {
  registerOfficialAccountActions(registry, async shell => {
    const home = app.getPath('home')
    const environment = shellInventory().environment()
    if (shell === 'codex') {
      const executable = await trustedCliExecutable('codex', process.platform, home, environment)
      return readCodexOfficialAccount(executable === undefined ? null : { executable, args: ['app-server', '--listen', 'stdio://'] }, home)
    }
    const executable = await trustedCliExecutable('claude-code', process.platform, home, environment)
    return readClaudeOfficialAccount(executable ?? null, home, environment)
  })
}
