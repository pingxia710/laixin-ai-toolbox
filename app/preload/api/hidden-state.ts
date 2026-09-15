import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

export interface HiddenStateSnapshot {
  readonly snapshot: string
}

export type HiddenStateInvoke = (name: string, params: unknown) => Promise<HiddenStateSnapshot>

export interface HiddenStateApi {
  scan(): Promise<HiddenStateSnapshot>
  /** 传空数组＝这次能处理的全处理。 */
  clean(input: { readonly ids: readonly string[] }): Promise<HiddenStateSnapshot>
  /** 把 clean 返回的那份凭据原样传回来，就能撤销。 */
  restore(input: { readonly receipt: string }): Promise<HiddenStateSnapshot>
}

/** 注入 invoke 便于单测；生产用下面那份接 ipcRenderer。 */
export function createHiddenStateApi(invoke: HiddenStateInvoke): HiddenStateApi {
  return {
    scan: () => invoke('aiaccess.hiddenState.scan', undefined),
    // 桥上只过字符串，数组在这一层转成 JSON，⛔ 让界面自己拼。
    clean: (input) => invoke('aiaccess.hiddenState.clean', { ids: JSON.stringify([...input.ids]) }),
    restore: (input) => invoke('aiaccess.hiddenState.restore', { receipt: input.receipt })
  }
}

export const namespace = 'hiddenstate'
export const api: HiddenStateApi = createHiddenStateApi((name, params) => ipcRenderer.invoke(IPC_CHANNEL, name, params))

declare global { interface ToolboxApi { readonly hiddenstate: HiddenStateApi } }
