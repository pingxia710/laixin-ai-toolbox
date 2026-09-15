import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

export interface ShellsApi {
  inventory(): Promise<{ snapshot: string }>
  install(input: { shell: string }): Promise<{ snapshot: string }>
  installStatus(): Promise<{ snapshot: string }>
  openOfficialPage(input: { shell: string }): Promise<{ snapshot: string }>
  open(input: { shell: string }): Promise<{ snapshot: string }>
  refreshRecipes(): Promise<{ snapshot: string }>
  reachability(input: { shell: string }): Promise<{ snapshot: string }>
}

export const namespace = 'shells'
export const api: ShellsApi = {
  inventory: () => ipcRenderer.invoke(IPC_CHANNEL, 'shells.inventory', undefined),
  install: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'shells.install', input),
  installStatus: () => ipcRenderer.invoke(IPC_CHANNEL, 'shells.installStatus', undefined),
  openOfficialPage: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'shells.openOfficialPage', input),
  open: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'shells.open', input),
  refreshRecipes: () => ipcRenderer.invoke(IPC_CHANNEL, 'shells.refreshRecipes', undefined),
  reachability: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'shells.reachability', input)
}

declare global { interface ToolboxApi { readonly shells: ShellsApi } }
