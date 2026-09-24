import { app, shell } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { createManagedTextFile } from '../ai-access/file'
import { installCodexWorkspaceProviders } from '../ai-access/codex-workspace-config'
import { launchCodexWorkspaceThread } from '../ai-access/codex-workspace-launcher'
import { CodexWorkspaceService } from '../ai-access/codex-workspaces'
import { findCodexDesktopCommand } from '../codex-usage/runtime'
import { productionAiAccessService } from './ai-access'

const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 10_000 }) })
const openSchema = schema.object({ source: schema.string({ maxLength: 20 }), key: schema.string({ maxLength: 512 }) })

export function registerCodexWorkspaceActions(registry: BridgeRegistry, service: CodexWorkspaceService): void {
  registry.registerAction({
    name: 'codexworkspaces.open',
    paramsSchema: openSchema,
    resultSchema,
    handler: async params => {
      const input = params as { source: string; key: string }
      return { snapshot: JSON.stringify(await service.open(input.source, input.key)) }
    }
  })
}

export function registerActions(registry: BridgeRegistry): void {
  const home = app.getPath('home')
  const file = createManagedTextFile()
  const service = new CodexWorkspaceService({
    access: productionAiAccessService(),
    findCommand: () => findCodexDesktopCommand(home),
    installProviders: codexHome => installCodexWorkspaceProviders({ codexHome, toolboxExecutable: process.execPath, file }),
    launch: (command, input) => launchCodexWorkspaceThread(command, { cwd: home, codexHome: input.codexHome, source: input.source }),
    openExternal: async url => { await shell.openExternal(url) }
  })
  registerCodexWorkspaceActions(registry, service)
}
