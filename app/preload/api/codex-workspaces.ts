import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { CodexWorkspaceSourceId } from '../../main/ai-access/codex-workspace-sources'

export interface CodexWorkspacesApi {
  open(input: { readonly source: CodexWorkspaceSourceId; readonly key: string }): Promise<{ readonly snapshot: string }>
}

export const namespace = 'codexworkspaces'
export const api: CodexWorkspacesApi = {
  open: input => ipcRenderer.invoke(IPC_CHANNEL, 'codexworkspaces.open', input)
}

declare global {
  interface ToolboxApi { readonly codexworkspaces: CodexWorkspacesApi }
}
