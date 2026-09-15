// 客户到底看到哪句话 + 让位时能不能看到对方真实状态(审查四轮 P1 两条)。
//
// 背景:失败路径上守护写进 state.json 的 message **就是 code 本身**(handleConnectFailure),
// 所以每加一个码都必须同时加客户文案,否则客户界面上会直接出现 TUNNEL_PEER_LAIXIN_RUNNING。
// status-service 里那段注释记着 0.4.9 踩过同一个坑,这次加争抢四码时又踩了一次。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectionMessage } from '../../app/main/tunnel/status-service'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'

// 两组 describe 共用:只驱动文案生成与失败落盘,连接相关的工厂给最小可满足实现即可。
function daemonOn(dataDir: string, now = () => 1_000_000) {
  return createDaemon({
    dataDir, adapter: { read: () => null, write: () => undefined, managedItems: () => [] },
    clock: { now, setInterval: () => 0, setTimeout: () => 0, clearTimer: () => undefined },
    parentAlive: () => true, onExit: () => undefined,
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined,
      localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '' }) }),
    bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
  }) as unknown as {
    writeRightConflict: (input: { reason: string; holder?: unknown }) => Error & { peerState?: string }
  }
}

const CONTENTION_CODES = [
  'TUNNEL_PEER_LAIXIN_RUNNING',
  'TUNNEL_SETTINGS_CONTEST_STOPPED',
  'TUNNEL_WRITE_RIGHT_HELD',
  'TUNNEL_WRITE_RIGHT_UNKNOWN'
] as const

describe('争抢相关的码必须变成人话', () => {
  it.each(CONTENTION_CODES)('%s 不能原样出现在客户眼前', (code) => {
    // 复现真实形态:失败路径写的是 message = code
    const shown = connectionMessage({ state: 'error', code, message: code } as never)
    expect(shown).not.toBe(code)
    expect(shown).not.toMatch(/TUNNEL_|_[A-Z]{2,}/)
    expect(shown.length).toBeGreaterThan(8)
    // 每条都要告诉客户能做什么
    expect(shown).toMatch(/请|联系/)
  })

  it('端口上发现另一份来信:客户看到的是「退出多余那一份再重连」', () => {
    const shown = connectionMessage({ state: 'error', code: 'TUNNEL_PEER_LAIXIN_RUNNING', message: 'TUNNEL_PEER_LAIXIN_RUNNING' } as never)
    expect(shown).toContain('已经有一份来信')
    expect(shown).toContain('重新连接')
  })

  it('两轮争抢止损:客户看到的是「已停手并保留对方设置」', () => {
    const shown = connectionMessage({ state: 'error', code: 'TUNNEL_SETTINGS_CONTEST_STOPPED', message: 'TUNNEL_SETTINGS_CONTEST_STOPPED' } as never)
    expect(shown).toContain('反复修改')
    expect(shown).toContain('保留')
    expect(shown).toContain('重新连接')
  })
})

describe('转呈的状态要真的能到界面', () => {
  // 断链风险:守护失败路径写的是 message = code,转呈的状态词会在落盘那一刻被丢掉。
  // 所以它单独落一个字段,由这里拼进客户看到的那句话。
  it('拼进客户文案:人话 +（那一份当前：已连接）', () => {
    const shown = connectionMessage({
      state: 'error', code: 'TUNNEL_WRITE_RIGHT_HELD', message: 'TUNNEL_WRITE_RIGHT_HELD', peerState: '已连接'
    } as never)
    expect(shown).toContain('另一个来信后台')
    expect(shown).toContain('那一份当前：已连接')
    expect(shown).not.toContain('TUNNEL_')
  })

  it('没读到对方状态:只给人话,⛔ 拼出半截空括号', () => {
    const shown = connectionMessage({ state: 'error', code: 'TUNNEL_WRITE_RIGHT_HELD', message: 'TUNNEL_WRITE_RIGHT_HELD' } as never)
    expect(shown).not.toContain('当前：')
    expect(shown).not.toContain('（）')
  })

  it('守护必须把状态词落进 state.json —— 否则界面拿不到它(这一环曾无用例保护)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-persist-'))
    try {
      writeFileSync(join(dir, 'intent.json'), JSON.stringify({ desired: 'connected', sessionToken: 't' }))
      const daemon = daemonOn(dir) as unknown as {
        intent?: unknown
        handleConnectFailure: (error: unknown) => Promise<void>
      }
      daemon.intent = { desired: 'connected' }
      await daemon.handleConnectFailure(Object.assign(new Error('x'), {
        code: 'TUNNEL_WRITE_RIGHT_HELD', peerState: '已连接'
      }))
      const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { code: string; peerState?: string }
      expect(state.code).toBe('TUNNEL_WRITE_RIGHT_HELD')
      expect(state.peerState).toBe('已连接')
      // 端到端:界面据此拼出那句话
      expect(connectionMessage(state as never)).toContain('那一份当前：已连接')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('端口上撞见另一份来信:同样要如实展示那一份当前的状态', () => {
    const shown = connectionMessage({
      state: 'error', code: 'TUNNEL_PEER_LAIXIN_RUNNING', message: 'TUNNEL_PEER_LAIXIN_RUNNING', peerState: '已连接'
    } as never)
    expect(shown).toContain('已经有一份来信')
    expect(shown).toContain('那一份当前：已连接')
  })

  // 真机证据(pdf7, Win11 ARM64, 2026-09-15 十分钟双候选版验收):把后启动那一份实际写出的
  // state.json 原样钉在这里 —— 客户看到的必须是这句人话,⛔ 退化成内部码。
  it('真机 state.json → 客户看到的那句话(pdf7 十分钟验收原样)', () => {
    const realState = {
      state: 'error', runId: '', sessionToken: '', intentToken: 'duel-b', bridgePort: 18080, note: '',
      code: 'TUNNEL_WRITE_RIGHT_HELD',
      message: '另一份来信（安装位置不同）正在管理这台电脑的网络（它当前：已连接）；本次不改动系统设置',
      updatedAt: 1789467626717
    }
    const shown = connectionMessage(realState as never)
    expect(shown).not.toMatch(/TUNNEL_|[A-Z]{3,}_[A-Z]/)
    expect(shown).toContain('另一份来信')
    expect(shown).toContain('它当前：已连接')
  })

  it('与对方无关的码 ⛔ 蹭这个后缀', () => {
    const shown = connectionMessage({
      state: 'error', code: '端口占用', message: '端口占用', peerState: '已连接'
    } as never)
    expect(shown).not.toContain('那一份当前')
  })
})

describe('让位时转呈持有者的真实状态', () => {
  // 名片与 state 靠**本次持权令牌**配对。stateToken 默认与名片一致(正常情形);
  // 传不同值就模拟「state 是上一任守护留下的旧货」。
  function withPeer(state: string, opts: { token?: string; stateToken?: string | null; cardAgeMs?: number; now?: number } = {}) {
    const now = opts.now ?? 1_000_000
    const token = opts.token ?? 'tok-current'
    const stateToken = opts.stateToken === undefined ? token : opts.stateToken
    const mine = mkdtempSync(join(tmpdir(), 'wr-mine-'))
    const peer = mkdtempSync(join(tmpdir(), 'wr-peer-'))
    writeFileSync(join(peer, 'state.json'), JSON.stringify({
      state, code: 'INTERNAL_CODE_X', message: 'C:\\Users\\someone\\secret\\path.log', bridgePort: 18080,
      ...(stateToken === null ? {} : { writeRightToken: stateToken })
    }))
    const daemon = daemonOn(mine, () => now)
    const holder = { pid: 4242, dataDir: peer, at: now - (opts.cardAgeMs ?? 0), runId: 'r', version: '', resident: false, token }
    return { daemon, holder, cleanup: () => { rmSync(mine, { recursive: true, force: true }); rmSync(peer, { recursive: true, force: true }) } }
  }

  it('对方已连接:如实转呈,⛔ 只给一句泛化的「有人在管理网络」', () => {
    const { daemon, holder, cleanup } = withPeer('connected')
    try {
      const error = daemon.writeRightConflict({ reason: 'held', holder })
      expect(error.message).toContain('已连接')
      expect(error.peerState).toBe('已连接')
    } finally { cleanup() }
  })

  it('对方出错:同样如实转呈(⛔ 一律说成已连接)', () => {
    const { daemon, holder, cleanup } = withPeer('error')
    try { expect(daemon.writeRightConflict({ reason: 'held', holder }).peerState).toBe('出错了') } finally { cleanup() }
  })

  it('⛔ 泄露对方的路径、内部码或 PID', () => {
    const { daemon, holder, cleanup } = withPeer('connected')
    try {
      const shown = daemon.writeRightConflict({ reason: 'held', holder }).message
      expect(shown).not.toContain('INTERNAL_CODE_X')
      expect(shown).not.toContain('secret')
      expect(shown).not.toContain('C:\\')
      expect(shown).not.toContain('4242')
      expect(shown).not.toContain(holder.dataDir)
    } finally { cleanup() }
  })

  it('新持权名片 + 遗留的旧 state.json:⛔ 把旧的「已连接」说成当前状态', () => {
    // 持有者刚拿到权(名片是新令牌),但数据目录里那份 state 还是上一任守护留下的。
    const { daemon, holder, cleanup } = withPeer('connected', { token: 'tok-new', stateToken: 'tok-previous-run' })
    try {
      const error = daemon.writeRightConflict({ reason: 'held', holder })
      expect(error.peerState).toBeUndefined()
      expect(error.message).toContain('正在管理这台电脑的网络')
      expect(error.message).not.toContain('已连接')
    } finally { cleanup() }
  })

  it('state 根本没盖令牌(更老的版本写的):同样不认', () => {
    const { daemon, holder, cleanup } = withPeer('connected', { stateToken: null })
    try { expect(daemon.writeRightConflict({ reason: 'held', holder }).peerState).toBeUndefined() } finally { cleanup() }
  })

  it('持权很久之后第二实例才启动:仍要展示真实状态,⛔ 因为「名片旧」就退化成泛化', () => {
    // 令牌匹配就是匹配 —— 互斥体是权威,持有者活得好好的,⛔ 拿时间去猜它死没死。
    const { daemon, holder, cleanup } = withPeer('connected', { cardAgeMs: 6 * 60 * 60_000 })
    try {
      const error = daemon.writeRightConflict({ reason: 'held', holder })
      expect(error.peerState).toBe('已连接')
      expect(error.message).toContain('它当前：已连接')
    } finally { cleanup() }
  })

  it('状态不在白名单 / 读不到:一律降级,⛔ 把陌生字符串端给客户', () => {
    const { daemon, holder, cleanup } = withPeer('some-unknown-state')
    try { expect(daemon.writeRightConflict({ reason: 'held', holder }).peerState).toBeUndefined() } finally { cleanup() }
    const gone = daemonOn(mkdtempSync(join(tmpdir(), 'wr-x-')))
    expect(gone.writeRightConflict({ reason: 'held', holder: { pid: 1, dataDir: 'C:\\nope', at: 1_000_000, token: 'x' } }).peerState).toBeUndefined()
    expect(gone.writeRightConflict({ reason: 'held', holder: undefined }).peerState).toBeUndefined()
  })
})
