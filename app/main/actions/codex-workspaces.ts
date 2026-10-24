import { app, shell } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { createManagedTextFile } from '../ai-access/file'
import { installCodexWorkspaceProviders } from '../ai-access/codex-workspace-config'
import { launchCodexWorkspaceThread, readCodexWorkspaceOfficialModels } from '../ai-access/codex-workspace-launcher'
import { CodexWorkspaceService } from '../ai-access/codex-workspaces'
import { findCodexDesktopCommand } from '../codex-usage/runtime'
import { productionAiAccessService } from './ai-access'

const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 10_000 }) })
const openSchema = schema.object({ source: schema.string({ maxLength: 20 }) })

export function registerCodexWorkspaceActions(registry: BridgeRegistry, service: CodexWorkspaceService): void {
  registry.registerAction({
    name: 'codexworkspaces.open',
    paramsSchema: openSchema,
    resultSchema,
    handler: async params => {
      const input = params as { source: string }
      return { snapshot: JSON.stringify(await service.open(input.source)) }
    }
  })
}

export function registerActions(registry: BridgeRegistry): void {
  const home = app.getPath('home')
  // The trusted Desktop catalogue contains full per-model instructions and is larger than a normal config.
  const file = createManagedTextFile({ maxBytes: 4 * 1024 * 1024 })
  const service = new CodexWorkspaceService({
    access: productionAiAccessService(),
    findCommand: () => findCodexDesktopCommand(home),
    readOfficialModels: command => readCodexWorkspaceOfficialModels(command, { cwd: home }),
    installProviders: (codexHome, multiModel, officialModels) => installCodexWorkspaceProviders({ codexHome, toolboxExecutable: process.execPath, multiModel, officialModels, file }),
    launch: (command, input) => launchCodexWorkspaceThread(command, { cwd: home, codexHome: input.codexHome, source: input.source }),
    openExternal: async url => { await shell.openExternal(url) }
  })
  registerCodexWorkspaceActions(registry, service)
}
