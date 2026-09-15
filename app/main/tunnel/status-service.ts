// 状态合并与脱敏(定稿第 2 轮 2 / 第 3 轮 2a):界面与日志只出白名单字段,
// ⛔ 凭据路径与内容 ⛔「已授权 / 可信 / 已认证」语义。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastIntentCached, ledgerFailureCached } from '../../../sidecar/mac/ledger.mjs'
import { unrestoredEntriesCached } from '../../../sidecar/mac/restore.mjs'
import { readCurrentInfo, readPendingInfo } from './import-meta'
import { hasInvalidPointers } from './transactions'
import { layout } from './paths'

export interface DaemonStateView {
  readonly state: string
  readonly runId?: string
  readonly sessionToken?: string
  readonly intentToken?: string
  readonly code?: string
  readonly message?: string
  readonly exitIp?: string
  readonly lastVerifiedAt?: number
  readonly bridgePort?: number
  /** 复用了电脑上现有的外网代理(未改系统设置)。 */
  // direct = 客户这台电脑本来就能到 AI 服务（VPN 走全局、人在墙外、公司专线），没有 host/port。
  readonly reusedProxy?: { kind: 'http' | 'socks' | 'pac' | 'direct'; host?: string; port?: number; url?: string; source?: string }
  /** 可选项说明(终端接入未启用等)。 */
  readonly note?: string
  /** 写入权被别的来信后台持有时,对方当前处于什么状态(白名单词,守护已做过安全过滤)。 */
  readonly peerState?: string
}

export interface TunnelStatus {
  readonly state: string
  readonly message: string
  readonly source: string
  readonly authorization: string
  readonly backend: string
  readonly nodeLabel: string
  readonly exitIp: string
  /** 这一刻客户的外网走的是哪条路:来信自己的通道 / 复用电脑上已有的外网 / 没有连接。
   * 界面、修复流程、诊断都按它判断,⛔ 各自从中文说明串里猜(GPT-6 网络加强研究 §六)。 */
  readonly pathSource: '' | 'laixin' | 'reused'
  readonly lastVerifiedAt: string
  readonly configVersion: string
  readonly expiresAt: string
  readonly pendingAvailable: boolean
  readonly currentConfig: string
  readonly pendingConfig: string
  readonly canApplyPending: boolean
  readonly unrestored: string
  readonly componentMissing: string
  // 随包 OpenSSH(Windows)有无的如实读数:有/无;非 Windows 为空串不展示。
  readonly sshBinary: string
  readonly traffic: string
}

export interface TrafficObservation {
  readonly source: 'local-proxy-entry'
  readonly uploadBytes: number
  readonly downloadBytes: number
  readonly uploadBytesPerSecond: number
  readonly downloadBytesPerSecond: number
  /** D3:此刻正在回数据的连接数,以及通道中断时被打断的累计条数(用户主动断开 ⛔ 计入)。 */
  readonly activeStreams: number
  readonly interruptedStreams: number
  readonly updatedAt: number
}

/** 复用态:守护没有改动任何系统设置,走的是客户电脑上本来就有的那条外网。 */
export function isReusedPath(daemon: DaemonStateView | undefined): boolean {
  return daemon?.code === 'TUNNEL_REUSED_EXISTING' && daemon.reusedProxy !== undefined
}

/** 「客户此刻确实有网可用」的统一判据(修复流程、诊断、界面共用)。
 * 复用态没有来信出口 IP 是正常的——我们一个字节都没改客户的设置,出口是对方那条路的;
 * ⛔ 拿「出口 IP 非空」当唯一完成条件:那会让复用成功的客户永远修不完(GPT-6 网络加强研究 §六)。 */
export function networkPathReady(status: TunnelStatus): boolean {
  if (status.state !== DISPLAY_STATES.connected || status.unrestored || !status.lastVerifiedAt) return false
  return status.pathSource === 'reused' || status.exitIp !== ''
}

export const STATUS_LINES = {
  authorization: '授权:本地包载明,未经后台确认',
  backend: '后台:未接入'
} as const

export const DISPLAY_STATES = {
  unconfigured: '未配置',
  connecting: '连接中',
  connected: '已连',
  degraded: '通道待确认',
  userDisconnected: '用户主动断开',
  error: '异常',
  stoppedRestored: '已停止并恢复原设置'
} as const

export interface StatusInput {
  readonly dataDir: string
  readonly daemonState: DaemonStateView | undefined
  readonly daemonUnexpectedExitAt: number | undefined
  // 收敛包3·件1:守护退避重启三次失败后放弃,状态层给「点连接重试」的出口。
  readonly daemonSurrendered?: boolean
  readonly componentMissing: readonly string[]
  // 随包 OpenSSH 读数(Windows):'有'/'无';非平台传空串。
  readonly sshBinary: string
}

export function computeStatus(input: StatusInput): TunnelStatus {
  const current = readCurrentInfo(input.dataDir)
  const pending = readPendingInfo(input.dataDir)
  // 配置信息行:有 current 看 current;只有 pending(导入未应用)也如实展示其三行状态
  const info = current ?? pending
  const daemon = input.daemonState
  // 一次 tick 只解析一次账本:mtime 未变时三个读取全部命中缓存,不再各自全量解析。
  const failure = ledgerFailureCached(input.dataDir)
  const invalidPointers = hasInvalidPointers(input.dataDir)
  const intent = failure ? undefined : lastIntentCached(input.dataDir)
  const unrestored = failure ? [] : unrestoredEntriesCached(input.dataDir)

  let state: string = DISPLAY_STATES.unconfigured
  let message = ''
  if (input.daemonSurrendered) {
    state = DISPLAY_STATES.error
    message = '网络守护已停止，点连接重试'
  } else if (current !== undefined) {
    state = DISPLAY_STATES.stoppedRestored
    if (input.daemonUnexpectedExitAt !== undefined) {
      state = DISPLAY_STATES.error
      message = '守护进程意外退出'
    } else if (daemon?.state === 'connected') {
      state = DISPLAY_STATES.connected
      // 已连状态下要带给客户的话:复用了本机现有外网 / 另一款代理软件在反复改系统代理 / 可选项(终端接入)没启用
      const lines = []
      if (daemon.code === 'TUNNEL_SETTINGS_CONTESTED' || daemon.code === 'TUNNEL_REUSED_EXISTING') lines.push(daemon.message ?? '')
      if (daemon.note) lines.push(daemon.note)
      message = lines.filter(Boolean).join('；')
    } else if (daemon?.state === 'degraded') {
      state = DISPLAY_STATES.degraded
      message = daemon.code === 'TUNNEL_PROBE_UNAVAILABLE' ? '检测服务暂不可用，正在保留原通道并重新检查' : '通道暂未确认，正在重新检查'
    } else if (daemon?.state === 'connecting') {
      state = DISPLAY_STATES.connecting
    } else if (daemon?.state === 'error') {
      state = DISPLAY_STATES.error
      message = connectionMessage(daemon)
    } else if (intent === 'user-disconnected') {
      state =
        daemon?.state === 'stopped-restored'
          ? DISPLAY_STATES.stoppedRestored
          : DISPLAY_STATES.userDisconnected
    }
  }
  const active = [DISPLAY_STATES.connected, DISPLAY_STATES.connecting, DISPLAY_STATES.degraded].some((value) => value === state)
  const unresolved = unrestored.filter((entry) => !active || entry.status !== 'applied')
  if (unresolved.length > 0) {
    state = DISPLAY_STATES.error
    message = `${message ? `${message}；` : ''}原设置尚未恢复，请重试恢复；其他软件修改的设置会保留`
  }

  if (failure || invalidPointers) {
    state = DISPLAY_STATES.error
    message = failure?.message ?? '配置记录损坏，请联系客服协助处理；原配置已保留'
  }

  return {
    state,
    message,
    source: info?.sourceLine ?? '',
    authorization: info === undefined ? '' : STATUS_LINES.authorization,
    backend: info === undefined ? '' : STATUS_LINES.backend,
    nodeLabel: info === undefined ? '' : `${info.node.host}:${String(info.node.port)}`,
    exitIp: state === DISPLAY_STATES.connected ? (daemon?.exitIp ?? '') : '',
    pathSource: state === DISPLAY_STATES.connected ? (isReusedPath(daemon) ? 'reused' : 'laixin') : '',
    lastVerifiedAt:
      state === DISPLAY_STATES.connected && daemon?.lastVerifiedAt !== undefined
        ? new Date(daemon.lastVerifiedAt).toISOString()
        : '',
    configVersion: info === undefined ? '' : String(info.configVersion),
    expiresAt: info?.expiresAt ?? '',
    pendingAvailable: pending !== undefined,
    currentConfig: configSummary(current),
    pendingConfig: configSummary(pending),
    canApplyPending: pending !== undefined && unrestored.length === 0 &&
      [DISPLAY_STATES.unconfigured, DISPLAY_STATES.stoppedRestored, DISPLAY_STATES.userDisconnected].some((allowed) => allowed === state),
    unrestored: failure ? failure.message : summarizeUnresolved(unresolved
      .map((entry) =>
        `${entry.service}/${entry.item}:${
          entry.status === 'kept-modified'
            ? '未恢复:已被改动'
            : entry.status === 'restore-failed'
              ? `未恢复:失败:${entry.note}`
              : '未恢复:未完成(进程中断)'
        }`
      )),
    componentMissing:
      input.componentMissing.length > 0 ? `组件缺失:${input.componentMissing.join(',')}` : '',
    sshBinary: input.sshBinary,
    traffic: active ? trafficSummary(input.dataDir) : ''
  }
}

// 未恢复项可能很多（整批网络服务出故障），拼接必须留在动作结果 schema 限长（300）以内，
// 放不下时截断并标注「等 N 项」，⛔ 让 tunnel.status 整个报 ACTION_RESULT_INVALID。
export function summarizeUnresolved(entries: readonly string[]): string {
  const joined = entries.join(';')
  if (joined.length <= 300) return joined
  const suffix = `;等${entries.length}项`
  let text = ''
  for (const entry of entries) {
    const next = text === '' ? entry : `${text};${entry}`
    if (next.length + suffix.length > 300) break
    text = next
  }
  if (text === '') return `${joined.slice(0, Math.max(0, 300 - suffix.length - 1))}…${suffix}`
  return `${text}${suffix}`
}

/** Reads only the numeric, locally-produced aggregate. No request metadata is stored or surfaced. */
export function readTrafficObservation(dataDir: string): TrafficObservation | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, 'traffic.json'), 'utf8')) as Record<string, unknown>
    const numericKeys = ['uploadBytes', 'downloadBytes', 'uploadBytesPerSecond', 'downloadBytesPerSecond',
      'activeStreams', 'interruptedStreams', 'updatedAt']
    if (value.source !== 'local-proxy-entry' || !Object.entries(value).every(([key, item]) =>
      key === 'source' || (numericKeys.includes(key) && Number.isSafeInteger(item) && (item as number) >= 0))) return undefined
    const fields = ['uploadBytes', 'downloadBytes', 'uploadBytesPerSecond', 'downloadBytesPerSecond', 'updatedAt'] as const
    if (fields.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return undefined
    return value as unknown as TrafficObservation
  } catch { return undefined }
}

function trafficSummary(dataDir: string): string {
  const observation = readTrafficObservation(dataDir)
  if (!observation || observation.updatedAt > Date.now() || Date.now() - observation.updatedAt > 10_000) return ''
  return `上传 ${formatBytes(observation.uploadBytesPerSecond)}/秒 · 下载 ${formatBytes(observation.downloadBytesPerSecond)}/秒 · 累计 ${formatBytes(observation.uploadBytes + observation.downloadBytes)}`
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function configSummary(info: ReturnType<typeof readCurrentInfo>): string {
  return info === undefined ? '' : `版本 ${String(info.configVersion)} · ${info.protocol === 'vless-reality' ? 'VLESS/REALITY' : 'SSH'} · ${info.node.host}:${String(info.node.port)} · 到期 ${info.expiresAt}`
}

// 守护 state.json 读取(主进程侧只读)
export function readDaemonState(dataDir: string): DaemonStateView | undefined {
  const path = layout.state(dataDir)
  if (!existsSync(path)) {
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DaemonStateView
  } catch {
    return undefined
  }
}

/**
 * 守护写进 state.json 的是**受控码**(失败路径上 `message` 就是 `code` 本身),所以这张表
 * 一律按码做 key。此前代理冲突那条用的 key 是 `'冲突:已有代理控制'`——那个字面只在 Windows
 * 适配器抛 ConnectorError 时出现过,**从来没进过 state.json**,于是 mac 与 Windows 的客户
 * 看到的都是裸码「已有代理控制」(0.4.9 上线检查 §4-2)。⛔ 再按文案猜。
 * 导出只为让用例能直接钉住「客户到底看到哪句话」。
 */
export function connectionMessage(daemon: DaemonStateView): string {
  const message = daemon.message || daemon.code || ''
  const instructions: Record<string, string> = {
    'TUNNEL_SETTINGS_NOT_APPLIED': '本机接入设置暂未生效，正在重试写入',
    '端口占用': '连接端口被其他软件占用，请关闭冲突的代理软件后重新连接',
    '节点身份不符': '节点身份校验未通过，请同步来信配置或联系客服',
    '授权失效': '通道授权已失效，请同步账号权益或更新来信配置',
    '配额或授权问题': '当前权益不可用，请查看流量、期限和开通状态',
    '已有代理控制': '检测到其他代理，请先在该软件中断开代理，再连接来信通道',
    '受管理环境': '系统代理受组织策略或权限限制，请联系设备管理员或来信客服',
    '组件缺失': '本机缺少网络组件，请联系来信客服更新工具箱',
    '已停止自动重连': '已停止自动重连，请检查网络后点击重新连接',
    // 连接争抢止损的四个码(2026-09-15)。⛔ 漏掉映射:失败路径上 message 就是 code 本身,
    // 漏一个客户就会看到「TUNNEL_PEER_LAIXIN_RUNNING」这种内部码——上面那段注释记的
    // 正是 0.4.9 同一个坑。每条都要说清**客户能做什么**。
    'TUNNEL_PEER_LAIXIN_RUNNING': '这台电脑上已经有一份来信在管理网络，请退出或卸载多余的那一份，再点击重新连接',
    'TUNNEL_SETTINGS_CONTEST_STOPPED': '系统代理正被这台电脑上的其他程序反复修改，来信已停手并保留它当前的设置；请关闭那个程序后点击重新连接',
    'TUNNEL_WRITE_RIGHT_HELD': '这台电脑的网络设置正由另一个来信后台管理，本次没有改动；请先退出那一份，再点击重新连接',
    'TUNNEL_WRITE_RIGHT_UNKNOWN': '暂时无法确认系统代理归属，本次没有改动网络设置；请点击重新连接，若仍不行请联系来信客服'
  }
  const text = instructions[message] ?? message
  // 对方的真实状态是动态的,查不了上面的静态表:在这里拼进去。
  // ⛔ 无脑拼:只有「被另一个来信后台占着」这一条才谈得上「对方当前怎样」。
  // 只有「另一份来信正占着」这两条才谈得上「那一份当前怎样」;别的码 ⛔ 蹭这个后缀。
  const peerAware = daemon.code === 'TUNNEL_WRITE_RIGHT_HELD' || daemon.code === 'TUNNEL_PEER_LAIXIN_RUNNING'
  return peerAware && typeof daemon.peerState === 'string' && daemon.peerState !== ''
    ? `${text}（那一份当前：${daemon.peerState}）`
    : text
}
