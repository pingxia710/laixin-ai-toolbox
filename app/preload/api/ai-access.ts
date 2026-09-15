import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { ApiRemedyAction, ApiShell as AiAccessShell, ModelProviderId } from '../../shared/api-service-types'

export interface AiAccessSnapshot {
  readonly snapshot: string
}

export interface AiAccessApi {
  status(): Promise<AiAccessSnapshot>
  /** Fixed 1–27 environment guidance; this is not a customer-state scan result. */
  environmentChecklist(): Promise<AiAccessSnapshot>
  /** Fixed process-presence guidance; it never exposes process IDs or command lines. */
  restartGuidance(input: { shell: AiAccessShell }): Promise<AiAccessSnapshot>
  /** Confirm the detected effective config scope before Toolbox writes it. */
  selectConfigurationTarget(input: { shell: AiAccessShell; scope: 'user' | 'project' }): Promise<AiAccessSnapshot>
  /** The native directory picker stays in the main process; no local path reaches the renderer. */
  selectConfigurationProject(input: { shell: 'claude' }): Promise<AiAccessSnapshot>
  /** Explicitly restore the connection saved before Toolbox took over; it may be another third-party tool. */
  restorePreviousConnection(input: { shell: AiAccessShell }): Promise<AiAccessSnapshot>
  saveProviderKey(input: { shell: AiAccessShell; provider: ModelProviderId; key: string }): Promise<AiAccessSnapshot>
  useProvider(input: { provider: ModelProviderId; shell: 'codex' | 'claude' | 'hermes' }): Promise<AiAccessSnapshot>
  configureProvider(input: { provider: ModelProviderId; shell: AiAccessShell; key: string; model: string }): Promise<AiAccessSnapshot>
  serviceStatus(): Promise<AiAccessSnapshot>
  providerConfiguration(input: { provider: ModelProviderId; shell: AiAccessShell }): Promise<AiAccessSnapshot>
  measureProviderLatency(input: { provider: ModelProviderId; shell: AiAccessShell; key: string; model?: string }): Promise<AiAccessSnapshot>
  openProviderConsole(input: { provider: ModelProviderId }): Promise<AiAccessSnapshot>
  testProvider(input: { provider: ModelProviderId; shell: 'codex' | 'claude' | 'hermes' }): Promise<AiAccessSnapshot>
  remedy(input: { shell: AiAccessShell; action: ApiRemedyAction; provider: string }): Promise<AiAccessSnapshot>
  recover(): Promise<AiAccessSnapshot>
  verifyConfiguration(): Promise<AiAccessSnapshot>
  probeMatrix(): Promise<AiAccessSnapshot>
  matrixStatus(): Promise<AiAccessSnapshot>
  useOfficial(input: { shell: 'codex' | 'claude' | 'hermes' }): Promise<AiAccessSnapshot>
  codexOfficialStatus(): Promise<AiAccessSnapshot>
  startCodexOfficialLogin(): Promise<AiAccessSnapshot>
  cancelCodexOfficialLogin(): Promise<AiAccessSnapshot>
  providerBalance(input: { provider: ModelProviderId; shell: 'codex' | 'claude' | 'hermes' }): Promise<AiAccessSnapshot>
  /** Mac 使用回执（API-04）：客户手动生成预览文本；只含白名单字段，无记录时如实返回。 */
  usageReceipt(): Promise<AiAccessSnapshot>
  /** 客户在预览后手动保存为本地文件；只认主进程预览快照标识，取消返回 canceled，⛔ 没有任何自动发送。 */
  usageReceiptSave(input: { snapshotId: string }): Promise<AiAccessSnapshot>
  claudeOfficialStatus(): Promise<AiAccessSnapshot>
  startClaudeOfficialLogin(): Promise<AiAccessSnapshot>
  submitClaudeLoginCode(input: { code: string }): Promise<AiAccessSnapshot>
  cancelClaudeOfficialLogin(): Promise<AiAccessSnapshot>
}

export const namespace = 'aiaccess'
export const api: AiAccessApi = {
  status: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.status', undefined),
  environmentChecklist: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.environmentChecklist', undefined),
  restartGuidance: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.restartGuidance', input),
  selectConfigurationTarget: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.selectConfigurationTarget', input),
  selectConfigurationProject: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.selectConfigurationProject', input),
  restorePreviousConnection: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.restorePreviousConnection', input),
  saveProviderKey: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.saveProviderKey', input),
  useProvider: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.useProvider', input),
  configureProvider: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.configureProvider', input),
  serviceStatus: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.serviceStatus', undefined),
  providerConfiguration: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.providerConfiguration', input),
  measureProviderLatency: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.measureProviderLatency', { ...input, model: input.model ?? '' }),
  openProviderConsole: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.openProviderConsole', input),
  testProvider: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.testProvider', input),
  remedy: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.remedy', input),
  recover: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.recover', undefined),
  verifyConfiguration: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.verifyConfiguration', undefined),
  probeMatrix: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.probeMatrix', undefined),
  matrixStatus: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.matrixStatus', undefined),
  useOfficial: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.useOfficial', input),
  codexOfficialStatus: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.codexOfficialStatus', undefined),
  startCodexOfficialLogin: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.startCodexOfficialLogin', undefined),
  cancelCodexOfficialLogin: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.cancelCodexOfficialLogin', undefined),
  providerBalance: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.providerBalance', input),
  usageReceipt: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.usageReceipt', undefined),
  usageReceiptSave: input => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.usageReceiptSave', input),
  claudeOfficialStatus: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.claudeOfficialStatus', undefined),
  startClaudeOfficialLogin: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.startClaudeOfficialLogin', undefined),
  submitClaudeLoginCode: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.submitClaudeLoginCode', input),
  cancelClaudeOfficialLogin: () => ipcRenderer.invoke(IPC_CHANNEL, 'aiaccess.cancelClaudeOfficialLogin', undefined)
}

declare global { interface ToolboxApi { readonly aiaccess: AiAccessApi } }
