import { join } from 'node:path'
import { probeApiNetwork, type ApiNetworkBinding } from '../../../sidecar/shared/api-network-continuation.mjs'
import { readRouterBusinessState } from './router-state'
import { readAiRouterRuntime } from './router-runtime'

/** A private handoff capability, never a renderer field or a provider credential. */
export async function readApiNetworkContinuation(userData: string, bridgePort: number): Promise<ApiNetworkBinding | undefined> {
  const state = await readRouterBusinessState(userData)
  const runtime = await readAiRouterRuntime(join(userData, 'ai-access'))
  if (!runtime || !state.codexMultiRelay || runtime.port !== state.codexMultiRelay.port) return undefined
  const binding = { port: runtime.port, pid: runtime.pid, bootId: runtime.bootId,
    identitySecret: state.codexMultiRelay.identitySecret, bridgePort }
  return await probeApiNetwork(binding) ? binding : undefined
}
