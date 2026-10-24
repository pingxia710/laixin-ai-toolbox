import { execFileSync } from 'node:child_process'
import { resolveActiveNetworkPath, type ActiveNetworkPath } from '../../../../sidecar/mac/active-network-path.mjs'

type ReadCommand = (file: string, args: readonly string[]) => string

function runReadCommand(file: string, args: readonly string[]): string {
  return execFileSync(file, [...args], {
    encoding: 'utf8', timeout: 1_000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' }
  })
}

/** 只读当前默认路由对应的唯一网络服务；缺失、冲突或切换时不猜。 */
export function readActiveMacNetworkPath(run: ReadCommand = runReadCommand): ActiveNetworkPath | undefined {
  const resolution = resolveActiveNetworkPath(run)
  return resolution.status === 'resolved' ? resolution.path : undefined
}
