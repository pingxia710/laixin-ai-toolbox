import { readTunnelSnapshot } from '../tunnel/runtime'
import type { TunnelSnapshot } from './types'

export function downloadTunnelSnapshot(): TunnelSnapshot {
  return readTunnelSnapshot()
}
