import { app, clipboard } from 'electron'
import { join } from 'node:path'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { buildDiagnosticsText, type DiagnosticsInput } from '../diagnostics/report'
import { faultLog } from '../diagnostics/context'
import { buildReportBody } from '../diagnostics/report-bundle'
import { collectLocalFiles, nodeReportFiles } from '../diagnostics/report-collect'
import { createElectronReportTransport, readSystemProxy } from '../diagnostics/report-session'
import { generateReceipt, saveReportLocally, uploadReport, type ReportTransport } from '../diagnostics/report-upload'
import { resolveTunnelDataDir } from '../tunnel/paths'
import { activeBridgePort } from '../tunnel/runtime-owner'
import type { ReportUpload } from '../../report-types'
import { recipeStore, shellInstaller } from '../shells/context'

declare const __TOOLBOX_ACCOUNT_ORIGIN__: string

const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 200_000 }) })
let lastText = ''

/** 上报**只有客户点按钮这一条入口**：⛔ 定时器、⛔ 启动时自动发、⛔ 后台拉取。
 * 这个动作以外没有任何地方调用 uploadReport——用例 report-only-on-click 盯着这条。 */
export async function runOneClickReport(deps: {
  readonly execute: (name: string, params?: unknown) => Promise<unknown>
  readonly transport?: ReportTransport
  readonly origin?: string
  readonly userDataPath: string
  readonly tunnelDataDir: string
  readonly appInfo?: ReportUpload['toolbox']
  readonly bridgePort?: number
  readonly now?: () => Date
}): Promise<{ receipt: string; uploaded: boolean; route?: string; filePath?: string; code?: string; message: string }> {
  const receipt = generateReceipt()
  const notes: string[] = []
  const read = async <T>(name: string, params?: unknown): Promise<T | undefined> => {
    try { return await deps.execute(name, params) as T } catch (error) { notes.push(`${name} 读不到：${error instanceof Error ? error.message : '未知原因'}`); return undefined }
  }
  const toolbox = deps.appInfo ?? await read<ReportUpload['toolbox']>('app.info') ?? { version: '未知', platform: process.platform, architecture: process.arch, packaged: false }
  const tunnel = await read<Record<string, unknown>>('tunnel.status')
  const repair = await read<Record<string, unknown>>('tunnel.repairStatus')
  const support = await read<{ customerId: string; deviceId: string }>('account.supportContext')
  const files = await collectLocalFiles({ userDataPath: deps.userDataPath, tunnelDataDir: deps.tunnelDataDir, files: nodeReportFiles })
  let systemProxy: Record<string, unknown> | undefined
  try { systemProxy = await readSystemProxy({ '来信后台': deps.origin ?? __TOOLBOX_ACCOUNT_ORIGIN__ ?? '', '外网站点': 'https://api.openai.com/' }) }
  catch (error) { notes.push(`系统代理读数读不到：${error instanceof Error ? error.name : '未知原因'}`) }
  const faults = await faultLog().recent(20).catch(() => { notes.push('本机故障留痕读不到'); return [] })
  const daemonState = files.daemonState as { code?: unknown } | undefined
  const errorCodes = [
    ...(typeof daemonState?.code === 'string' ? [daemonState.code] : []),
    ...(typeof repair?.code === 'string' ? [repair.code] : []),
    ...faults.flatMap((fault) => [fault.code, fault.network].filter((code): code is string => typeof code === 'string'))
  ]
  // 未恢复的系统设置：通道状态里那句现成的读数就够客服判断，⛔ 再去 sidecar 里捞一份原始条目。
  const body = buildReportBody({ tunnel, repair, daemonState: files.daemonState, ledger: files.ledger,
    systemProxy, connection: files.connection, daemonLog: files.daemonLog, faults, errorCodes,
    notes: [...files.notes, ...notes] })
  const account = support && (support.customerId || support.deviceId)
    ? { ...(support.customerId ? { id: support.customerId } : {}), ...(support.deviceId ? { deviceId: support.deviceId } : {}) }
    : undefined
  const createdAt = (deps.now?.() ?? new Date()).toISOString()
  const pack = (id: string): string => JSON.stringify({ receipt: id, createdAt, toolbox, ...(account ? { account } : {}), body } satisfies ReportUpload)
  const origin = deps.origin ?? __TOOLBOX_ACCOUNT_ORIGIN__
  const directory = join(deps.userDataPath, 'reports')
  if (!origin) {
    const filePath = await saveReportLocally(directory, receipt, pack(receipt))
    return { receipt, uploaded: false, filePath, message: '本机还没连上来信后台，诊断包已存在本机文件里，发给客服即可。' }
  }
  const url = new URL('v1/report/upload', origin.endsWith('/') ? origin : `${origin}/`).toString()
  const transport = deps.transport ?? createElectronReportTransport()
  const bridgePort = deps.bridgePort ?? activeBridgePort()
  let current = receipt
  let outcome = await uploadReport({ url, payload: pack(current), transport, bridgePort })
  // 回执号撞上了（后台只创建不覆盖）：换一个号再发一次，⛔ 让客户白点一次。
  if (!outcome.ok && outcome.code === 'REPORT_RECEIPT_TAKEN') {
    current = generateReceipt()
    outcome = await uploadReport({ url, payload: pack(current), transport, bridgePort })
  }
  if (outcome.ok) return { receipt: current, uploaded: true, route: outcome.route, message: `已上报，回执号 ${current}。把它告诉客服即可。` }
  const filePath = await saveReportLocally(directory, current, pack(current))
  return { receipt: current, uploaded: false, filePath, ...(outcome.code ? { code: outcome.code } : {}),
    message: `这次没能送出去（回执号 ${current}）。诊断包已存在本机，把这个文件发给客服，效果一样。` }
}

export function registerActions(registry: BridgeRegistry): void {
  registry.registerAction({ name: 'diagnostics.run', paramsSchema: schema.undefined(), resultSchema, handler: async () => {
    const errors: string[] = []
    const read = async <T>(name: string, params?: unknown): Promise<T | undefined> => {
      try { return await registry.execute(name, params) as T } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); return undefined }
    }
    const unwrap = <T>(value: { snapshot: string } | undefined): T | undefined => { try { return value ? JSON.parse(value.snapshot) as T : undefined } catch { return undefined } }
    const app = await read<DiagnosticsInput['app']>('app.info')
    const tunnel = await read<Record<string, unknown>>('tunnel.status')
    const networkRepair = await read<Record<string, unknown>>('tunnel.repairStatus')
    const network = unwrap<Record<string, unknown>>(await read('networkdiagnostics.run', { software: 'codex' }))
    const shells = unwrap<Record<string, unknown>[]>(await read('shells.inventory'))
    const access = unwrap<Record<string, unknown>>(await read('aiaccess.status'))
    const service = unwrap<Record<string, unknown>>(await read('aiaccess.serviceStatus'))
    const desktop = unwrap<Record<string, unknown>>(await read('desktop.status'))
    const balances: Record<string, unknown>[] = []
    for (const [shell, detail] of Object.entries((access?.shells ?? {}) as Record<string, Record<string, unknown>>)) {
      const provider = detail.selected
      if (typeof provider !== 'string' || provider === 'official' || provider === 'zai') continue
      const balance = unwrap<Record<string, unknown>>(await read('aiaccess.providerBalance', { shell, provider }))
      if (balance && !balances.some((b) => b.provider === balance.provider)) balances.push(balance)
    }
    // 网络检查判出问题就留一条，客服看得到「那次是哪一层不通」。
    const blocked = ((network?.checks ?? []) as Record<string, unknown>[]).find((check) => check.state === 'attention' || check.state === 'unknown')
    if (blocked && typeof blocked.code === 'string') await faultLog().record({ network: blocked.code }).catch(() => undefined)
    const faults = await faultLog().recent(20).catch(() => [])
    const input: DiagnosticsInput = { collectedAt: new Date().toLocaleString('zh-CN'), app, tunnel, networkRepair, network, shells, access, service, desktop, balances,
      recipesVersion: recipeStore().current().version, install: shellInstaller().status() as unknown as Record<string, unknown>, faults, errors }
    lastText = buildDiagnosticsText(input)
    // 界面要分列显示,所以把结构化记录一起给出去;⛔ 让渲染层回头拆 text 里的句子。
    return { snapshot: JSON.stringify({ text: lastText, collectedAt: input.collectedAt, errors, faults }) }
  } })
  // 一键上报。⛔ 任何自动触发：只有渲染层的按钮会调到这里。
  registry.registerAction({ name: 'diagnostics.report', paramsSchema: schema.undefined(), resultSchema, handler: async () => {
    const userDataPath = app.getPath('userData')
    const result = await runOneClickReport({ execute: (name, params) => registry.execute(name, params),
      userDataPath, tunnelDataDir: resolveTunnelDataDir(process.env, userDataPath) })
    return { snapshot: JSON.stringify(result) }
  } })
  registry.registerAction({ name: 'diagnostics.copy', paramsSchema: schema.undefined(), resultSchema, handler: () => {
    if (!lastText) return { snapshot: JSON.stringify({ copied: false }) }
    clipboard.writeText(lastText)
    return { snapshot: JSON.stringify({ copied: true }) }
  } })
}
