// 一键诊断：把已有各项读数汇成一页，能复制给客服。不脱敏（创始人定），但从不包含 Key、令牌、密码。
import { faultLine, type FaultRecord } from '../../shared/fault-log-types'

export interface DiagnosticsInput {
  readonly collectedAt: string
  readonly app?: { version: string; platform: string; architecture: string; packaged: boolean }
  readonly tunnel?: Record<string, unknown>
  readonly networkRepair?: Record<string, unknown>
  readonly network?: Record<string, unknown>
  readonly shells?: readonly Record<string, unknown>[]
  readonly access?: Record<string, unknown>
  readonly service?: Record<string, unknown>
  readonly desktop?: Record<string, unknown>
  readonly balances?: readonly Record<string, unknown>[]
  readonly recipesVersion?: number
  readonly install?: Record<string, unknown>
  /** 最近的故障经过与已试过的处理（按天留存，新的在前）。 */
  readonly faults?: readonly FaultRecord[]
  readonly errors: readonly string[]
}

const str = (value: unknown): string => value === undefined || value === null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)

export function buildDiagnosticsText(input: DiagnosticsInput): string {
  const lines: string[] = []
  lines.push(`来信AI工具箱 诊断信息 ${input.collectedAt}`)
  lines.push(`软件：${input.app ? `${input.app.version} · ${input.app.platform}/${input.app.architecture} · ${input.app.packaged ? '安装版' : '开发版'}` : '未读到'}`)
  lines.push(`配方版本：${input.recipesVersion ?? '—'}`)
  lines.push('')
  lines.push('【AI网络】')
  const t = input.tunnel ?? {}
  lines.push(`状态：${str(t.state)} · ${str(t.message)}`)
  lines.push(`配置：${str(t.currentConfig)} · 节点：${str(t.nodeLabel)} · 出口：${str(t.exitIp)} · 到期：${str(t.expiresAt)} · 最近复验：${str(t.lastVerifiedAt)}`)
  if (t.unrestored) lines.push(`未恢复的系统设置：${str(t.unrestored)}`)
  if (t.componentMissing) lines.push(`组件缺失：${str(t.componentMissing)}`)
  if (typeof t.sshBinary === 'string' && t.sshBinary !== '') lines.push(`随包 OpenSSH(SSH 稳定版需要)：${str(t.sshBinary)}`)
  lines.push(`账号权益：${str(t.authorization)} · 后台：${str(t.backend)}`)
  const repair = input.networkRepair
  if (repair && repair.outcome !== 'idle') {
    lines.push(`本次网络修复：${str(repair.startedAt)} → ${str(repair.finishedAt)} · ${str(repair.phase)} · ${str(repair.outcome)} · ${str(repair.code)}`)
    lines.push(`修复结论：${str(repair.message)}`)
  }
  if (input.network) {
    lines.push('连通检查：')
    const layers = (input.network.layers ?? input.network.results ?? input.network.steps) as unknown
    if (Array.isArray(layers)) for (const layer of layers) lines.push(`  - ${str((layer as Record<string, unknown>).label ?? (layer as Record<string, unknown>).id)}：${str((layer as Record<string, unknown>).state ?? (layer as Record<string, unknown>).status)} ${str((layer as Record<string, unknown>).detail ?? (layer as Record<string, unknown>).message)}`)
    else lines.push(`  ${str(input.network)}`)
  }
  lines.push('')
  lines.push('【已装的 AI】')
  for (const shell of input.shells ?? []) {
    const installed = shell.installed === true ? `已装 ${str(shell.version)}` : shell.installed === false ? '未装' : '无法判断'
    lines.push(`${str(shell.label)}：${installed}${shell.latest ? ` · 最新 ${str(shell.latest)}` : ''}${shell.updatable ? ' · 可更新' : ''}${shell.location ? ` · ${str(shell.location)}` : ''}`)
  }
  if (input.install && input.install.phase !== 'idle') lines.push(`最近安装任务：${str(input.install.shell)} ${str(input.install.phase)} ${str(input.install.message)}`)
  lines.push('')
  lines.push('【模型接入】')
  const shells = (input.access?.shells ?? {}) as Record<string, Record<string, unknown>>
  for (const [shell, detail] of Object.entries(shells)) {
    const keys = Object.entries((detail.providerKeys ?? {}) as Record<string, boolean>).filter(([, saved]) => saved).map(([provider]) => provider)
    lines.push(`${shell}：当前 ${str(detail.selected)} · 已存 Key：${keys.length ? keys.join('、') : '无'}`)
  }
  const attempt = input.access?.attempt as Record<string, unknown> | undefined
  if (attempt) lines.push(`最近一次接入检查：${str(attempt.shell)}/${str(attempt.provider)} ${attempt.ok ? '通过' : `未通过 ${str(attempt.code)}`}${attempt.notice ? ` ${str(attempt.notice)}` : ''} @ ${str(attempt.at)}`)
  const service = input.service ?? {}
  lines.push(`本机 API 服务：${service.running ? `运行中 ${str(service.baseUrl)}` : '未运行'}${service.startupError ? ` · ${str(service.startupError)}` : ''}`)
  // 「测过 / 写了 / 真的在用」分开写，客服一眼看出客户卡在哪一步。
  for (const stage of (service.usage ?? []) as Record<string, unknown>[]) {
    if (!stage.provider) continue
    lines.push(`  ${str(stage.shell)} 接入进度：接口测试 ${stage.tested ? str(stage.tested) : '未通过'} · 配置已写 ${stage.configured ? str(stage.configured) : '本次运行未写入'} · 观察到软件调用 ${stage.observedClientCall ? str(stage.observedClientCall) : '尚未观察到'}`)
  }
  const requests = (service.requests ?? []) as Record<string, unknown>[]
  const recent = requests.slice(0, 5)
  if (recent.length) { lines.push('最近调用：'); for (const r of recent) lines.push(`  - ${str(r.at)} ${str(r.shell)}/${str(r.provider)} ${str(r.model)} ${r.ok ? 'ok' : `失败 ${str(r.code)}`} ${str(r.status)} ${str(r.durationMs)}ms`) }
  for (const balance of input.balances ?? []) {
    lines.push(`余额（${str(balance.provider)}）：${balance.supported === false ? '该服务商无余额接口' : balance.total !== null && balance.total !== undefined ? `${str(balance.total)} ${str(balance.currency)}` : `未读到 ${str(balance.error)}`}${balance.peak ? ` · ${str((balance.peak as Record<string, unknown>).label)}` : ''}`)
  }
  lines.push('')
  lines.push('【工具箱】')
  const update = (input.desktop?.update ?? {}) as Record<string, unknown>
  lines.push(`更新：${str(update.state)} ${str(update.version)} ${str(update.message)}`)
  const preferences = (input.desktop?.preferences ?? {}) as Record<string, unknown>
  lines.push(`自动更新：${preferences.autoUpdate === false ? '关' : '开'} · 后台运行：${input.desktop?.backgroundAvailable ? '可用' : '不可用'}`)
  lines.push('')
  lines.push('【最近故障与已试过的处理】')
  // 客服最想知道的是「客户已经试过什么」；这里只有判类、动作与结果，⛔ Key、令牌与对话正文。
  if (!input.faults?.length) lines.push('本机没有留存的故障记录。')
  else for (const fault of input.faults.slice(0, 20)) lines.push(`- ${faultLine(fault)}`)
  if (input.errors.length) { lines.push(''); lines.push('【读取失败的项】'); for (const error of input.errors) lines.push(`- ${error}`) }
  return lines.join('\n')
}
