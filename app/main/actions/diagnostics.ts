import { app, clipboard } from 'electron'
import { randomBytes } from 'node:crypto'
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
import { activeBridgePort, readReportRuntimeProvenance } from '../tunnel/runtime-owner'
import { DISPLAY_STATES } from '../tunnel/status-service'
import { ENTRY_STATUS, isIntactLedgerEntry, isOptionalSettingService, lockHolderAlive } from '../../../sidecar/mac/ledger.mjs'
import { readInstanceLock } from '../../../sidecar/shared/instance-lock.mjs'
import type { ReportUpload } from '../../report-types'
import { recipeStore, shellInstaller } from '../shells/context'
import { readSelection } from './network-diagnostics'
import { boundedDiagnosticPathContext, diagnosticSelectionFingerprint, diagnosticTunnelFingerprint, freshDiagnosticConnection,
  isDiagnosticSoftware, resolveDiagnosticTarget, type DiagnosticTunnel } from '../network-diagnostics/service'
import { readDiagnosticPathContext } from '../network-diagnostics/electron-probe'
import { collectLocalEgressEvidence } from '../network-diagnostics/local-egress'
import { normalizeLocalEgressEvidence, unknownLocalEgressEvidence, type LocalEgressEvidence } from '../../shared/local-egress-evidence'
import { faultColumns, type FaultRecord } from '../../shared/fault-log-types'
import type { NetworkRepairStatus } from '../../shared/network-repair'
import type { DiagnosticSoftware, NetworkDiagnosticReport } from '../../network-diagnostics-types'
import { buildSupportSummary, createSupportDiagnosis, selectSupportAttempts, supportSessionInvalidReason,
  type SupportAttempt, type SupportDiagnosis, type SupportSessionContext } from '../diagnostics/support-snapshot'

declare const __TOOLBOX_ACCOUNT_ORIGIN__: string

const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 200_000 }) })
const oneShotRestoreCodes = new Set(['TUNNEL_WRITE_RIGHT_HELD', 'TUNNEL_RESTORE_INCOMPLETE',
  'TUNNEL_RESTORE_TIMEOUT', 'TUNNEL_RESTORE_SPAWN_FAILED'])
const oneShotProxyInspectionCodes = new Set(['TUNNEL_PROXY_INSPECTION_FAILED', 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN'])

export interface DiagnosticsActionDeps {
  readonly now?: () => number
  readonly createId?: () => string
  readonly recentFaults?: () => Promise<readonly FaultRecord[]>
  readonly recordNetworkFault?: (code: string) => Promise<void>
  readonly recipesVersion?: () => number
  readonly installStatus?: () => Record<string, unknown>
  readonly copyText?: (text: string) => void
  readonly submitReport?: (diagnosis: SupportDiagnosis, faults: readonly FaultRecord[]) => Promise<ReportResult>
  readonly collectLocalEgress?: () => Promise<LocalEgressEvidence>
  readonly pathContext?: (url: string) => Promise<string>
}

export interface ReportResult {
  readonly receipt: string
  readonly uploaded: boolean
  readonly route?: string
  readonly filePath?: string
  readonly code?: string
  readonly message: string
}

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
  readonly runtimeProvenance?: () => { readonly spawnRunId?: string; readonly lastSpawnAt?: number;
    readonly residentOnlyRunning?: boolean; readonly restoring: boolean } | undefined
  readonly now?: () => Date
  readonly diagnosis?: SupportDiagnosis
  readonly diagnosisUnavailableSoftware?: DiagnosticSoftware
  /** 诊断时冻结的记录；传入后上报不得再读一份较新的故障记录拼进去。 */
  readonly faults?: readonly FaultRecord[]
  /** 补充读数可能耗时；真正上传或落盘前再确认旧诊断仍有效。 */
  readonly validateDiagnosis?: () => Promise<boolean>
}): Promise<ReportResult> {
  const receipt = generateReceipt()
  const notes: string[] = deps.diagnosis ? [] : ['本次诊断未完成；仅采集当前连接状态与日志。']
  const read = async <T>(name: string, params?: unknown): Promise<T | undefined> => {
    try { return await deps.execute(name, params) as T } catch (error) { notes.push(`${name} 读不到：${error instanceof Error ? error.message : '未知原因'}`); return undefined }
  }
  const toolbox = deps.appInfo ?? await read<ReportUpload['toolbox']>('app.info') ?? { version: '未知', platform: process.platform, architecture: process.arch, packaged: false }
  const repair = await read<Record<string, unknown>>('tunnel.repairStatus')
  const support = await read<{ customerId: string; deviceId: string }>('account.supportContext')
  const files = await collectLocalFiles({ userDataPath: deps.userDataPath, tunnelDataDir: deps.tunnelDataDir, files: nodeReportFiles })
  const tunnel = await read<Record<string, unknown>>('tunnel.status')
  let systemProxy: Record<string, unknown> | undefined
  try { systemProxy = await readSystemProxy({ '来信后台': deps.origin ?? __TOOLBOX_ACCOUNT_ORIGIN__ ?? '', '外网站点': 'https://api.openai.com/' }) }
  catch (error) { notes.push(`系统代理读数读不到：${error instanceof Error ? error.name : '未知原因'}`) }
  const faults = deps.faults ?? await faultLog().recent(20).catch(() => { notes.push('本机故障留痕读不到'); return [] })
  const daemonState = files.daemonState as { state?: unknown; code?: unknown; runId?: unknown;
    intentToken?: unknown; updatedAt?: unknown } | undefined
  const stateCode = typeof daemonState?.code === 'string' && daemonState.code.length > 0 ? daemonState.code : undefined
  const stateIntentToken = daemonState?.intentToken
  let stateCodeCurrent = false
  if (stateCode !== undefined) {
    let runtime: ReturnType<NonNullable<typeof deps.runtimeProvenance>>
    try { runtime = deps.runtimeProvenance?.() }
    catch { notes.push('本轮网络运行时来源读不到') }
    let intent: { sessionToken?: unknown; updatedAt?: unknown } | undefined
    try {
      const text = await nodeReportFiles.readText(join(deps.tunnelDataDir, 'intent.json'), deps.tunnelDataDir)
      if (text === undefined) notes.push('当前意图 intent.json 不存在')
      else intent = JSON.parse(text) as { sessionToken?: unknown; updatedAt?: unknown }
    } catch { notes.push('当前意图 intent.json 读不到或格式有误') }
    let seat: ReturnType<typeof readInstanceLock>
    let seatReadable = true
    try { seat = readInstanceLock(deps.tunnelDataDir) }
    catch { seatReadable = false; notes.push('当前守护席位读不到') }
    let seatAlive = false
    if (seat?.holder !== undefined) {
      try { seatAlive = lockHolderAlive(seat.holder) }
      catch { seatReadable = false; notes.push('当前守护席位身份无法核对') }
    }
    const stateAt = daemonState?.updatedAt
    const intentAt = intent?.updatedAt
    const stateAfterIntent = Number.isSafeInteger(stateAt) && (stateAt as number) >= 0 &&
      (intentAt === undefined || Number.isSafeInteger(intentAt) && (stateAt as number) >= (intentAt as number))
    const restoreAfterIntent = Number.isSafeInteger(stateAt) && Number.isSafeInteger(intentAt) &&
      (stateAt as number) >= (intentAt as number)
    const sameIntent = typeof stateIntentToken === 'string' && stateIntentToken.length > 0 &&
      typeof intent?.sessionToken === 'string' && intent.sessionToken.length > 0 &&
      stateIntentToken === intent.sessionToken
    const seatAt = seat?.holder?.at
    const spawnRunId = runtime?.spawnRunId
    const stateMatchesSeat = seatReadable && seatAlive && daemonState?.runId === seat?.holder?.runId &&
      Number.isSafeInteger(seatAt) && (stateAt as number) >= (seatAt as number)
    const sameDaemonRun = typeof daemonState?.runId === 'string' && daemonState.runId.length > 0 &&
      (runtime?.residentOnlyRunning === true ? stateMatchesSeat
        : spawnRunId ? daemonState.runId === spawnRunId
          : runtime === undefined && stateMatchesSeat)
    let restoreStillIncomplete = false
    let proxyInspectionRecent = false
    const lastSpawnAt = runtime?.lastSpawnAt
    if (runtime?.restoring === false && runtime.residentOnlyRunning !== true && seatReadable && !seatAlive &&
        (seat === undefined || seat.holder !== undefined) &&
        daemonState?.state === 'error' && !daemonState.runId && !stateIntentToken &&
        (oneShotRestoreCodes.has(stateCode) || oneShotProxyInspectionCodes.has(stateCode)) &&
        restoreAfterIntent && (lastSpawnAt === undefined || Number.isSafeInteger(lastSpawnAt) &&
          (stateAt as number) > lastSpawnAt) && tunnel?.state === DISPLAY_STATES.error) {
      const ledger = files.ledgerMissing ? [] : files.ledger
      if (Array.isArray(ledger) && ledger.every(isIntactLedgerEntry)) {
        const unresolved = ledger.some((entry) => entry.kind === 'setting' && !isOptionalSettingService(entry.service) &&
          [ENTRY_STATUS.applied, ENTRY_STATUS.keptModified, ENTRY_STATUS.restoreFailed].includes(entry.status))
        const statusUnresolved = typeof tunnel.unrestored === 'string' && tunnel.unrestored.includes(':未恢复')
        restoreStillIncomplete = oneShotRestoreCodes.has(stateCode) && unresolved && statusUnresolved
        proxyInspectionRecent = oneShotProxyInspectionCodes.has(stateCode) && unresolved === statusUnresolved
      } else notes.push('当前设置账本无法核对')
    }
    stateCodeCurrent = sameIntent && stateAfterIntent && sameDaemonRun || restoreStillIncomplete || proxyInspectionRecent
    if (restoreStillIncomplete) notes.push('一次性恢复错误与当前未恢复设置相符；错误码表示最近一次恢复尝试。')
    if (proxyInspectionRecent) notes.push('最近一次代理检查失败；当前代理归属仍需复验。')
    if (!stateCodeCurrent) notes.push('state.json 错误码是原始读数，未经本轮核对（意图、守护席位或恢复状态不能确认），不能单独作为本次根因。')
  }
  const errorCodes = [
    ...(stateCodeCurrent && stateCode !== undefined ? [stateCode] : []),
    ...(typeof repair?.code === 'string' ? [repair.code] : []),
    ...faults.flatMap((fault) => [fault.code, fault.network].filter((code): code is string => typeof code === 'string'))
  ]
  if (deps.validateDiagnosis && !(await deps.validateDiagnosis())) throw new Error('DIAGNOSTIC_CONTEXT_CHANGED')
  const createdAt = (deps.now?.() ?? new Date()).toISOString()
  // 未恢复的系统设置：通道状态里那句现成的读数就够客服判断，⛔ 再去 sidecar 里捞一份原始条目。
  const body = buildReportBody({ tunnel, repair, daemonState: files.daemonState, ledger: files.ledger,
    systemProxy, connection: files.connection, daemonLog: files.daemonLog, faults, errorCodes,
    diagnosis: deps.diagnosis, diagnosisUnavailableSoftware: deps.diagnosisUnavailableSoftware,
    supplementalCollectedAt: createdAt, notes: [...files.notes, ...notes] })
  const account = support && (support.customerId || support.deviceId)
    ? { ...(support.customerId ? { id: support.customerId } : {}), ...(support.deviceId ? { deviceId: support.deviceId } : {}) }
    : undefined
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

interface StoredSupportSession {
  readonly diagnosis: SupportDiagnosis
  readonly text: string
  readonly faults: readonly FaultRecord[]
  readonly context: SupportSessionContext
  readonly collectedAt: string
}

interface ContextCapture {
  readonly capturedAt: number
  readonly context: SupportSessionContext
  readonly tunnel?: Record<string, unknown>
  readonly repair?: NetworkRepairStatus
  readonly faults: readonly FaultRecord[]
  readonly attempts: readonly SupportAttempt[]
  readonly attemptsTotal: number
  readonly attemptsComplete: boolean
}

const unwrap = <T>(value: { snapshot: string } | undefined): T | undefined => {
  try { return value ? JSON.parse(value.snapshot) as T : undefined } catch { return undefined }
}

function diagnosticId(): string {
  const value = randomBytes(6).toString('hex').toUpperCase()
  return `DG-${value.slice(0, 6)}-${value.slice(6)}`
}

function tunnelView(value: unknown): DiagnosticTunnel | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const field = (name: string): string => typeof item[name] === 'string' ? item[name] as string : ''
  return { state: field('state'), lastVerifiedAt: field('lastVerifiedAt'), configVersion: field('configVersion'),
    nodeLabel: field('nodeLabel'), unrestored: field('unrestored'), componentMissing: field('componentMissing') }
}

function repairView(value: unknown): NetworkRepairStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as NetworkRepairStatus
}

function attemptsFor(software: DiagnosticSoftware, faults: readonly FaultRecord[], repair: NetworkRepairStatus | undefined,
  fallbackAt: number): readonly SupportAttempt[] {
  const attempts: SupportAttempt[] = faults.filter((fault) => fault.shell === software && fault.action !== undefined).map((fault) => {
    const columns = faultColumns(fault)
    return { at: fault.at, software: columns.software, action: columns.tried, outcome: columns.outcome || '复验结果未知', detail: columns.category }
  })
  if (repair && repair.phase !== 'idle' && repair.outcome !== 'idle') {
    const outcomes: Readonly<Record<NetworkRepairStatus['outcome'], string>> = {
      idle: '未执行', running: '仍在进行', recovered: '已恢复', still_failing: '仍有问题', unknown: '不能确认', cancelled: '已取消'
    }
    const candidate = repair.finishedAt || repair.startedAt
    attempts.push({
      at: Number.isFinite(Date.parse(candidate)) ? candidate : new Date(fallbackAt).toISOString(),
      software: 'AI 网络', action: '检测并修复连接', outcome: outcomes[repair.outcome],
      ...(repair.code && /^[A-Z][A-Z0-9_]{2,63}$/.test(repair.code) ? { detail: repair.code } : {})
    })
  }
  return attempts
}

async function captureContext(registry: BridgeRegistry, software: DiagnosticSoftware, report: NetworkDiagnosticReport,
  now: () => number, recentFaults: () => Promise<readonly FaultRecord[]>, pathContext: (url: string) => Promise<string>): Promise<ContextCapture> {
  let selection
  try { selection = await readSelection(registry, software) } catch { selection = undefined }
  let repair: NetworkRepairStatus | undefined
  let repairReadable = false
  try { repair = repairView(await registry.execute('tunnel.repairStatus', undefined)); repairReadable = repair !== undefined } catch { /* 保留读不到。 */ }
  let faults: readonly FaultRecord[] = []
  let faultsReadable = false
  try { faults = await recentFaults(); faultsReadable = true } catch { /* 保留读不到。 */ }
  let pathFingerprint = 'not-required'
  if (report.pathMatrix !== undefined) {
    try { pathFingerprint = await boundedDiagnosticPathContext(pathContext(resolveDiagnosticTarget(software, selection).url)) }
    catch { pathFingerprint = 'unreadable' }
  }
  // 通道及时间都在其余异步读数结束后取；否则 89 秒证据可能在慢读期间跨过 90 秒仍被当成新鲜。
  let tunnel: Record<string, unknown> | undefined
  let tunnelReadable = false
  try { tunnel = await registry.execute('tunnel.status', undefined) as Record<string, unknown>; tunnelReadable = true } catch { /* 保留读不到。 */ }
  const selected = selectSupportAttempts(attemptsFor(software, faults, repair, report.checkedAt))
  const status = tunnelView(tunnel)
  const capturedAt = now()
  return {
    capturedAt, tunnel, repair, faults, attempts: selected.attempts, attemptsTotal: selected.total,
    attemptsComplete: faultsReadable && repairReadable,
    context: {
      selectionFingerprint: selection === undefined ? 'unreadable' : diagnosticSelectionFingerprint(selection),
      serviceRunning: selection?.routed === true ? selection.serviceRunning ?? null : null,
      tunnelRequired: report.target.route === 'tunnel' || report.pathMatrix !== undefined,
      tunnelReadable,
      tunnelFingerprint: diagnosticTunnelFingerprint(status),
      tunnelVerified: status !== undefined && freshDiagnosticConnection(status, capturedAt),
      repairFingerprint: repairReadable ? JSON.stringify({ running: repair?.running, phase: repair?.phase, outcome: repair?.outcome,
        code: repair?.code, startedAt: repair?.startedAt, finishedAt: repair?.finishedAt }) : 'unreadable',
      attemptsFingerprint: faultsReadable ? JSON.stringify(selected) : 'unreadable',
      pathFingerprint
    }
  }
}

function relevantFaults(software: DiagnosticSoftware, faults: readonly FaultRecord[]): readonly FaultRecord[] {
  return faults.filter((fault) => fault.shell === software || fault.shell === undefined)
}

const staleMessage = '这次诊断已过期，或相关配置、通道、修复状态已经变化。请保持当前状态不变并重新检查。'

export function registerActions(registry: BridgeRegistry, deps: DiagnosticsActionDeps = {}): void {
  const now = deps.now ?? Date.now
  const recentFaults = deps.recentFaults ?? (() => faultLog().recent(20))
  const recordNetworkFault = deps.recordNetworkFault ?? ((code: string) => faultLog().record({ network: code }))
  const recipesVersion = deps.recipesVersion ?? (() => recipeStore().current().version)
  const installStatus = deps.installStatus ?? (() => shellInstaller().status() as unknown as Record<string, unknown>)
  const copyText = deps.copyText ?? ((text: string) => clipboard.writeText(text))
  const pathContext = deps.pathContext ?? readDiagnosticPathContext
  let latest: StoredSupportSession | undefined
  let generation = 0

  const current = async (id: string): Promise<StoredSupportSession | undefined> => {
    const session = latest
    if (!session || session.diagnosis.id !== id) return undefined
    const capture = await captureContext(registry, session.diagnosis.report.software, session.diagnosis.report, now, recentFaults, pathContext)
    if (latest !== session) return undefined
    if (supportSessionInvalidReason(session.diagnosis.report, session.context, capture.context, capture.capturedAt) !== undefined) {
      latest = undefined
      return undefined
    }
    return session
  }

  const runDiagnostic = async (software: string, fresh: boolean): Promise<{ snapshot: string }> => {
    if (!isDiagnosticSoftware(software)) throw new Error('DIAGNOSTIC_SOFTWARE_INVALID')
    // 报障若撞上旧探测，先让底层拒绝；别作废旧页面正在完成的诊断。
    const freshNetwork = fresh ? await registry.execute('networkdiagnostics.runFresh', { software }) as { snapshot: string } : undefined
    const request = ++generation
    latest = undefined
    const errors: string[] = []
    const read = async <T>(name: string, actionParams?: unknown): Promise<T | undefined> => {
      try { return await registry.execute(name, actionParams) as T } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); return undefined }
    }
    const network = unwrap<NetworkDiagnosticReport>(freshNetwork ?? await read<{ snapshot: string }>('networkdiagnostics.run', { software }))
    if (!network || network.software !== software || !Number.isSafeInteger(network.checkedAt) || !Number.isSafeInteger(network.validUntil)) {
      throw new Error('DIAGNOSTIC_REPORT_INVALID')
    }
    let localEgress: LocalEgressEvidence
    try { localEgress = normalizeLocalEgressEvidence(await (deps.collectLocalEgress ?? collectLocalEgressEvidence)()) ??
      unknownLocalEgressEvidence(process.platform, now()) }
    catch { localEgress = unknownLocalEgressEvidence(process.platform, now()) }
    const blocked = network.checks.find((check) => check.state === 'attention' || check.state === 'unknown')
    if (blocked) await recordNetworkFault(blocked.code).catch(() => undefined)
    const before = await captureContext(registry, software, network, now, recentFaults, pathContext)
    const appInfo = await read<DiagnosticsInput['app']>('app.info')
    const shells = unwrap<Record<string, unknown>[]>(await read('shells.inventory'))
    const access = unwrap<Record<string, unknown>>(await read('aiaccess.status'))
    const service = unwrap<Record<string, unknown>>(await read('aiaccess.serviceStatus'))
    const desktop = unwrap<Record<string, unknown>>(await read('desktop.status'))
    const balances: Record<string, unknown>[] = []
    for (const [shell, detail] of Object.entries((access?.shells ?? {}) as Record<string, Record<string, unknown>>)) {
      const provider = detail.selected
      if (typeof provider !== 'string' || provider === 'official' || provider === 'zai') continue
      const balance = unwrap<Record<string, unknown>>(await read('aiaccess.providerBalance', { shell, provider }))
      if (balance && !balances.some((item) => item.provider === balance.provider)) balances.push(balance)
    }
    const after = await captureContext(registry, software, network, now, recentFaults, pathContext)
    if (request !== generation) throw new Error('DIAGNOSTIC_CONTEXT_CHANGED')
    if (supportSessionInvalidReason(network, before.context, after.context, after.capturedAt) !== undefined) throw new Error('DIAGNOSTIC_CONTEXT_CHANGED')
    const faults = relevantFaults(software, after.faults)
    const diagnosis = createSupportDiagnosis(deps.createId?.() ?? diagnosticId(), network, after.attempts,
      after.attemptsComplete, after.attemptsTotal, localEgress)
    const collectedAt = new Date(after.capturedAt).toLocaleString('zh-CN')
    const input: DiagnosticsInput = { collectedAt, app: appInfo, tunnel: after.tunnel, networkRepair: after.repair as unknown as Record<string, unknown>,
      network: network as unknown as Record<string, unknown>, shells, access, service, desktop, balances,
      recipesVersion: recipesVersion(), install: installStatus(), faults, errors }
    const text = `${buildSupportSummary(diagnosis)}\n\n【同次补充读数】\n补充采集时间：${collectedAt}\n${buildDiagnosticsText(input)}`
    latest = { diagnosis, text, faults, context: after.context, collectedAt }
    return { snapshot: JSON.stringify({ id: diagnosis.id, software, text, collectedAt, errors, faults, network, localEgress,
      attempts: diagnosis.attempts, attemptsTotal: diagnosis.attemptsTotal, attemptsComplete: diagnosis.attemptsComplete }) }
  }
  const runParamsSchema = schema.object({ software: schema.string({ maxLength: 12 }) })
  registry.registerAction({
    name: 'diagnostics.run', paramsSchema: runParamsSchema, resultSchema,
    handler: (params) => runDiagnostic((params as { software: string }).software, false)
  })
  registry.registerAction({
    name: 'diagnostics.runForReport', paramsSchema: runParamsSchema, resultSchema,
    handler: (params) => runDiagnostic((params as { software: string }).software, true)
  })
  // 一键上报。⛔ 任何自动触发：只有渲染层的按钮会调到这里。
  // 空 id 是本次诊断未完成后的即时信息路径；非空 id 继续绑定同次诊断。
  const report = async (id: string, diagnosisUnavailableSoftware?: DiagnosticSoftware): Promise<{ snapshot: string }> => {
    const session = id === '' ? undefined : await current(id)
    if (id !== '' && !session) return { snapshot: JSON.stringify({ uploaded: false, stale: true, message: staleMessage }) }
    const userDataPath = app.getPath('userData')
    try {
      const result = session && deps.submitReport
        ? await deps.submitReport(session.diagnosis, session.faults)
        : await runOneClickReport({ execute: (name, actionParams) => registry.execute(name, actionParams),
          runtimeProvenance: readReportRuntimeProvenance,
          userDataPath, tunnelDataDir: resolveTunnelDataDir(process.env, userDataPath),
          ...(diagnosisUnavailableSoftware ? { diagnosisUnavailableSoftware } : {}),
          ...(session ? { diagnosis: session.diagnosis, faults: session.faults,
            validateDiagnosis: async () => (await current(id)) !== undefined } : {}) })
      return { snapshot: JSON.stringify(result) }
    } catch (error) {
      if (error instanceof Error && error.message === 'DIAGNOSTIC_CONTEXT_CHANGED') {
        if (latest === session) latest = undefined
        return { snapshot: JSON.stringify({ uploaded: false, stale: true, message: staleMessage }) }
      }
      throw error
    }
  }
  registry.registerAction({ name: 'diagnostics.report',
    paramsSchema: schema.object({ id: schema.string({ maxLength: 24 }) }), resultSchema,
    handler: (params) => report((params as { id: string }).id)
  })
  registry.registerAction({ name: 'diagnostics.reportIncomplete',
    paramsSchema: runParamsSchema, resultSchema,
    handler: (params) => {
      const software = (params as { software: string }).software
      if (!isDiagnosticSoftware(software)) throw new Error('DIAGNOSTIC_SOFTWARE_INVALID')
      return report('', software)
    }
  })
  registry.registerAction({
    name: 'diagnostics.copy', paramsSchema: schema.object({ id: schema.string({ maxLength: 24 }) }), resultSchema,
    handler: async (params) => {
      const id = (params as { id: string }).id
      if (id === '') {
        const errors: string[] = []
        const read = async <T>(name: string): Promise<T | undefined> => {
          try { return await registry.execute(name, undefined) as T } catch { errors.push(`${name} 读不到`); return undefined }
        }
        const appInfo = await read<DiagnosticsInput['app']>('app.info')
        const tunnel = await read<Record<string, unknown>>('tunnel.status')
        const networkRepair = await read<Record<string, unknown>>('tunnel.repairStatus')
        const faults = await recentFaults().catch(() => { errors.push('本机故障留痕读不到'); return [] })
        const text = `${buildDiagnosticsText({ collectedAt: new Date(now()).toLocaleString('zh-CN'), app: appInfo,
          tunnel, networkRepair, faults, errors })}\n\n未选择具体软件；未运行针对软件的检查。`
        copyText(text)
        return { snapshot: JSON.stringify({ copied: true, stale: false, message: '已复制当前网络信息。' }) }
      }
      const session = await current(id)
      if (!session) return { snapshot: JSON.stringify({ copied: false, stale: true, message: staleMessage }) }
      copyText(session.text)
      return { snapshot: JSON.stringify({ copied: true, stale: false, message: '已复制本次诊断。' }) }
    }
  })
}
