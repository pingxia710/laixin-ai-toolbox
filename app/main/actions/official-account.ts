import { app } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { sharedAddedOfficialAccounts } from '../ai-access/added-accounts'
import { readClaudeOfficialAccount, readCodexOfficialAccount } from '../ai-access/official-account'
import { shellInventory } from '../shells/context'
import { trustedCliExecutable, trustedCliExecutables } from '../shells/inventory'
import type { OfficialAccount, OfficialAccountState } from '../../shared/official-account'

/** 闸口的登记表来源；结构化接口让测试可以直接喂临时实例。 */
export interface OfficialAccountGate {
  key(shell: 'codex' | 'claude'): Promise<string | null>
}

export function registerOfficialAccountActions(registry: BridgeRegistry, read: (shell: 'codex' | 'claude') => Promise<OfficialAccount>,
  added: OfficialAccountGate): void {
  registry.registerAction({
    name: 'officialaccount.read', paramsSchema: schema.object({ shell: schema.string({ maxLength: 20 }) }),
    resultSchema: schema.object({ snapshot: schema.string({ maxLength: 2000 }) }),
    handler: async params => {
      const { shell } = params as { shell: string }
      if (shell !== 'codex' && shell !== 'claude') throw new Error('OFFICIAL_ACCOUNT_SHELL_INVALID')
      // 判据（创始人定）：没登录就不该扫本机账号——登记表为空时 read 一次都不许被调，
      // ⛔ 先扫完再按结果决定显不显示。读到手的账号与登记指纹不一致也按未登录引导。
      const addedKey = await added.key(shell)
      if (addedKey === null) return { snapshot: JSON.stringify(empty('signed-out')) }
      const account = await read(shell)
      const verified = account.state === 'signed-in' && account.accountKey === addedKey
      return { snapshot: JSON.stringify(verified ? account : empty('signed-out')) }
    }
  })
}

export function registerActions(registry: BridgeRegistry): void {
  registerOfficialAccountActions(registry, productionRead, sharedAddedOfficialAccounts())
}

function productionRead(shell: 'codex' | 'claude'): Promise<OfficialAccount> {
  const home = app.getPath('home')
  const environment = shellInventory().environment()
  if (shell === 'codex') {
    return trustedCliExecutables('codex', process.platform, home, environment).then(executables =>
      readCodexOfficialAccount(executables.map(executable => ({ executable, args: ['app-server', '--listen', 'stdio://'] })), home))
  }
  return trustedCliExecutable('claude-code', process.platform, home, environment).then(executable =>
    readClaudeOfficialAccount(executable ?? null, home, environment))
}

function empty(state: OfficialAccountState): OfficialAccount {
  return { state, accountLabel: null, plan: null }
}
