import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import { BridgeError } from './action-registry'
import type { ActionRegistry } from './action-registry'
import type { FrameLike } from './source-guard'
import { isAllowedBridgeSource } from './source-guard'

export { IPC_CHANNEL }

interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, name: string, params: unknown) => Promise<unknown>): void
}

export interface IpcBridgeOptions {
  readonly registry: ActionRegistry
  readonly mainFrame: () => FrameLike | null
  readonly entryUrl: () => string
  readonly received?: () => void
}

export function installIpcBridge(ipc: IpcMainLike, options: IpcBridgeOptions): void {
  ipc.handle(IPC_CHANNEL, async (event, name, params) => {
    options.received?.()
    const senderFrame = event.senderFrame as FrameLike | null
    if (!isAllowedBridgeSource(senderFrame, { mainFrame: options.mainFrame() }, options.entryUrl())) {
      throw new BridgeError('IPC_SOURCE_NOT_ALLOWED')
    }
    return options.registry.execute(name, params)
  })
}
