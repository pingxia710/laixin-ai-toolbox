import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { AiApplicationId, AiApplicationView, DesktopView, UpdateView } from '../../desktop-types'

export const namespace = 'desktop'
// 桥上多数 desktop 动作返回 { snapshot: JSON 字符串 }，read() 负责解开。
const read = async <T>(method: string, params?: unknown): Promise<T> => JSON.parse((await ipcRenderer.invoke(IPC_CHANNEL, `desktop.${method}`, params) as { snapshot: string }).snapshot) as T
// 开关类动作（loginItem / residentEnabled 那几个）返回的是普通对象，⛔ 走 read()——
// 那等于 JSON.parse(undefined)，每次都抛；设置页把它 catch 成「暂时无法读取…状态」，
// 开关一直是灰的、客户永远开不了，而且不报任何错（0.4.10 的开机自启就是这么坏掉的）。
const call = <T>(method: string, params?: unknown): Promise<T> => ipcRenderer.invoke(IPC_CHANNEL, `desktop.${method}`, params) as Promise<T>
type ToggleStatus = { enabled: boolean; supported: boolean }
// active = 常驻此刻真的武装着。enabled && !active = 客户选了开、这次没生效。
// staleResidentTask = 没生效且是存量管理员任务对不上(甲-10 返工):重试永远不会成功,设置页换自救文案。
type ResidentStatus = ToggleStatus & { active: boolean; staleResidentTask: boolean }
export const api = {
  ready: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNEL, 'desktop.ready', undefined),
  status: () => read<DesktopView>('status'),
  configure: (input: { zoom: string; quotaNotifications: boolean; autoUpdate: boolean }) => read<DesktopView>('configure', input),
  applications: () => read<AiApplicationView[]>('applications'),
  openApplication: (id: AiApplicationId): Promise<{ opened: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNEL, 'desktop.openApplication', { id }),
  checkUpdate: () => read<UpdateView>('checkUpdate'),
  downloadUpdate: () => read<UpdateView>('downloadUpdate'),
  installUpdate: () => read<UpdateView>('installUpdate'),
  loginItem: (): Promise<ToggleStatus> => call('loginItem'),
  setLoginItem: (input: { enabled: boolean }): Promise<ToggleStatus> => call('setLoginItem', input),
  residentEnabled: (): Promise<ResidentStatus> => call('residentEnabled'),
  setResidentEnabled: (input: { enabled: boolean }): Promise<ResidentStatus> => call('setResidentEnabled', input),
  // FB-1:连接失败自动回传故障类型(设置页开关,默认开)。
  failureReportEnabled: (): Promise<ToggleStatus> => call('failureReportEnabled'),
  setFailureReportEnabled: (input: { enabled: boolean }): Promise<ToggleStatus> => call('setFailureReportEnabled', input),
  onNavigate: (listener: (tab: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tab: unknown) => { if (typeof tab === 'string') listener(tab) }
    ipcRenderer.on('toolbox:desktop-navigation', handler)
    return () => { ipcRenderer.removeListener('toolbox:desktop-navigation', handler) }
  },
  // 「更新成功」弹窗内容:装完后的第一次启动返回非空 version,其余启动返回空串三件套。
  updateSuccess: (): Promise<{ version: string; previous: string; notes: string }> => call('updateSuccess'),
  // 回执写好的那一刻的推送(它可能晚于渲染层启动,所以 updateSuccess 拉取也要在)。
  onUpdateSucceeded: (listener: (notice: { version: string; previous: string; notes: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, notice: unknown) => {
      if (typeof notice === 'object' && notice !== null && typeof (notice as { version?: unknown }).version === 'string') {
        listener(notice as { version: string; previous: string; notes: string })
      }
    }
    ipcRenderer.on('toolbox:update-succeeded', handler)
    return () => { ipcRenderer.removeListener('toolbox:update-succeeded', handler) }
  }
}
declare global { interface ToolboxApi { readonly desktop: typeof api } }
