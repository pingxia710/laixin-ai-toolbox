// 通道 sidecar-mac 片 · 统一入口反向变体(派工方 2026-09-06 23:57 追加裁定的落地)。
// 契约(tests/verify-bridge-build.mjs 自动发现,A 轨单写者定型 ⛔ 本片碰):
//   文件名即变体 id;导出 expectedFailure + 生命周期钩子。
// 硬判据:本片 handler 未注册时统一入口必须变红 —— verifyBeforeMutation 正向探真调用,
// mutateVerificationProject 把 handler 改名,verifyAfterMutation 探针必须拿到 ACTION_NOT_FOUND。
// 自检问句(B 轨教训):把 window.toolbox.tunnel 整个拿掉,verifyBeforeMutation 会红
// (探针 TypeError ⇒ error 回传 ⇒ throw);把 handler 改名,verifyAfterMutation 恒红 —— 不是恒绿。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeTunnelStatus } from '../tunnel/bridge-selfcheck.mjs'

export const expectedFailure = 'TUNNEL_BRIDGE_HANDLER_UNREGISTERED'

// 正向:handler 在桥上且经 window.toolbox.tunnel 调到,拿到 schema 校验过的返回。
export async function verifyBeforeMutation({ tempRoot }) {
  const result = await probeTunnelStatus(tempRoot)
  if (result.error !== undefined) {
    throw new Error(`TUNNEL_BRIDGE_PROBE_ERROR:${result.error}`)
  }
  if (result.state !== '未配置' || result.source !== '' || result.pending !== 'false') {
    throw new Error(`TUNNEL_BRIDGE_VALID_RESULT_MISSING:${JSON.stringify(result)}`)
  }
  process.stdout.write(`TUNNEL_BRIDGE_VALID_RESULT=${JSON.stringify(result)}\n`)
}

// 变体:本片 handler 未注册(tunnel.status 改名 ⇒ preload 调 tunnel.status 必 ACTION_NOT_FOUND)。
export function mutateVerificationProject(tempRoot) {
  const path = join(tempRoot, 'app/main/actions/tunnel.ts')
  const source = readFileSync(path, 'utf8')
  const needle = "name: 'tunnel.status'"
  if (!source.includes(needle)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(needle, "name: 'tunnel.absent'"))
}

// 反向:handler 未注册后探针必须失败且失败形态 = ACTION_NOT_FOUND(桥 schema/注册表真实拦截)。
export async function verifyAfterMutation({ tempRoot }) {
  const result = await probeTunnelStatus(tempRoot)
  if (result.error === undefined || !result.error.includes('ACTION_NOT_FOUND')) {
    throw new Error(`TUNNEL_BRIDGE_COUNTERFACTUAL_DID_NOT_FAIL:${JSON.stringify(result)}`)
  }
  process.stdout.write(`TUNNEL_BRIDGE_HANDLER_REMOVED=${JSON.stringify(result)}\n`)
  throw new Error(expectedFailure)
}
