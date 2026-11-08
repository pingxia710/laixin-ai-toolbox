import { join } from 'node:path'
import { acquireInstanceLock, readInstanceLock } from '../../../sidecar/shared/instance-lock.mjs'
import { lockHolderAlive } from '../../../sidecar/shared/ledger.mjs'

const guiRoot = (dataDir: string) => join(dataDir, 'controller-gui')
const controllerRoot = (dataDir: string) => join(dataDir, 'controller-owner')

/** GUI announces intent first; the background owner drains before releasing its seat. */
export function guiNetworkControllerPresent(dataDir: string): boolean {
  const observed = readInstanceLock(guiRoot(dataDir))
  return observed !== undefined && (observed.holder === undefined || lockHolderAlive(observed.holder))
}

export function acquireBackgroundNetworkController(dataDir: string): (() => void) | undefined {
  if (guiNetworkControllerPresent(dataDir)) return undefined
  const seat = acquireInstanceLock(controllerRoot(dataDir), { runId: 'api-network-controller' })
  if (!seat.acquired) return undefined
  if (guiNetworkControllerPresent(dataDir)) { seat.release(); return undefined }
  return seat.release
}

export async function acquireGuiNetworkController(dataDir: string, timeoutMs = 30_000): Promise<() => void> {
  const presence = acquireInstanceLock(guiRoot(dataDir), { runId: 'gui-network-controller' })
  if (!presence.acquired) throw new Error('NETWORK_CONTROLLER_BUSY')
  try {
    const deadline = Date.now() + timeoutMs
    do {
      const seat = acquireInstanceLock(controllerRoot(dataDir), { runId: 'gui-network-controller' })
      if (seat.acquired) return () => { seat.release(); presence.release() }
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    throw new Error('NETWORK_CONTROLLER_BUSY')
  } catch (error) { presence.release(); throw error }
}
