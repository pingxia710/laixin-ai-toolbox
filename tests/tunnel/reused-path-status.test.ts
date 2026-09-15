// 复用本机已有外网时的状态一致性（GPT-6 网络加强研究 §六 指出的两处衔接，本轮复现并修）。
// 事实前提：复用成功时守护不改任何系统设置，也拿不到「来信出口 IP」——出口是对方那条路的，我们没有它。
// 改之前：① 修复流程把「出口 IP 非空」当唯一完成条件 → 复用成功的客户网络明明可用，修复却一直等到超时；
//        ② 网络页在复用态照样说「本机代理设置和通道出口已完成校验」——我们根本没有应用过任何设置。
import { describe, expect, it } from 'vitest'
import { DISPLAY_STATES, computeStatus, isReusedPath, networkPathReady, type DaemonStateView, type TunnelStatus } from '../../app/main/tunnel/status-service'
import { buildTunnelPresentation } from '../../app/renderer/src/pages/tunnel'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'
import { makeTempDir, removeTempDir } from './helpers'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const reusedDaemon: DaemonStateView = {
  state: 'connected', runId: 'r', sessionToken: 's', code: 'TUNNEL_REUSED_EXISTING',
  message: '已复用本机现有外网（127.0.0.1:7890），未改动系统设置；它失效时会自动改用来信网络',
  reusedProxy: { kind: 'http', host: '127.0.0.1', port: 7890 }, exitIp: '', lastVerifiedAt: Date.parse('2026-09-13T10:00:00Z')
}
const laixinDaemon: DaemonStateView = {
  state: 'connected', runId: 'r', sessionToken: 's', code: '', message: '',
  exitIp: '203.0.113.42', lastVerifiedAt: Date.parse('2026-09-13T10:00:00Z')
}

// 状态判定要求「已导入配置」才可能是已连；这里造一份最小的已导入批次（不起任何进程）。
function statusOf(daemon: DaemonStateView): TunnelStatus {
  const dataDir = makeTempDir('reused-path-')
  try {
    const batchId = '20260913000000-a1b2c3d4'
    mkdirSync(join(dataDir, 'imports', batchId, 'credentials'), { recursive: true })
    writeFileSync(join(dataDir, 'imports', batchId, 'manifest.json'), JSON.stringify({
      protocol: 'vless-reality', verifyUrl: 'https://laixin.net.cn/exit-ip', configVersion: 1,
      authorizationId: 'lx-' + 'a'.repeat(32), node: { host: '198.51.100.7', port: 443 },
      expiresAt: '2099-01-01T00:00:00Z', files: { 'credentials/vless.json': 'x' }
    }))
    writeFileSync(join(dataDir, 'imports', batchId, 'credentials', 'vless.json'), '{}')
    writeFileSync(join(dataDir, 'current'), batchId)
    return computeStatus({ dataDir, daemonState: daemon, componentMissing: [], sshBinary: '',
      daemonUnexpectedExitAt: undefined })
  } finally { removeTempDir(dataDir) }
}

describe('复用本机已有外网时的状态', () => {
  it('复用态被如实标成 reused，来信自己的通道标成 laixin，没连接时为空', () => {
    expect(isReusedPath(reusedDaemon)).toBe(true)
    expect(isReusedPath(laixinDaemon)).toBe(false)
    expect(statusOf(reusedDaemon).pathSource).toBe('reused')
    expect(statusOf(laixinDaemon).pathSource).toBe('laixin')
    expect(statusOf({ state: 'stopped-restored' }).pathSource).toBe('')
  })

  it('「客户此刻有网可用」：复用态没有来信出口 IP 也算可用（改前这里为 false，修复因此永远等不到完成）', () => {
    const reused = statusOf(reusedDaemon)
    expect(reused.exitIp).toBe('') // 事实前提：复用时我们没有出口 IP
    expect(networkPathReady(reused)).toBe(true)
    expect(networkPathReady(statusOf(laixinDaemon))).toBe(true)
  })

  it('不能因此放水：来信通道自己没验出出口 IP、或原设置未恢复，都不算可用', () => {
    expect(networkPathReady(statusOf({ ...laixinDaemon, exitIp: '' }))).toBe(false)
    expect(networkPathReady(statusOf({ ...laixinDaemon, lastVerifiedAt: undefined }))).toBe(false)
    expect(networkPathReady({ ...statusOf(laixinDaemon), unrestored: 'Wi-Fi/socks-proxy' })).toBe(false)
    expect(networkPathReady(statusOf({ state: 'error', code: 'X', message: 'x' }))).toBe(false)
    // 只有 code 没有 reusedProxy 的半截状态不算复用，⛔ 凭一个字符串放行
    expect(networkPathReady(statusOf({ ...reusedDaemon, reusedProxy: undefined }))).toBe(false)
  })

  it('网络页在复用态说的是「用你原有的外网、没改设置」，⛔ 说通道出口已校验', () => {
    const view = (partial: Partial<TunnelStatusView>): TunnelStatusView => ({
      currentConfig: '', pendingConfig: '', canApplyPending: false, state: DISPLAY_STATES.connected, message: '', source: '',
      authorization: '', backend: '', nodeLabel: '', exitIp: '', pathSource: '', lastVerifiedAt: '2026-09-13T10:00:00.000Z',
      configVersion: '', expiresAt: '', pendingAvailable: false, unrestored: '', componentMissing: '', ...partial
    })
    const reused = buildTunnelPresentation(view({ pathSource: 'reused' }))
    expect(reused.description).toContain('原有的外网')
    expect(reused.description).not.toContain('通道出口已完成校验')
    expect(reused.primaryLabel).not.toBe('断开通道') // ⛔ 让客户以为点一下会关掉别人的软件
    const laixin = buildTunnelPresentation(view({ pathSource: 'laixin', exitIp: '203.0.113.42' }))
    expect(laixin.description).toContain('通道出口已完成校验')
  })
})
