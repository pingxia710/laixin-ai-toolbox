// 上报要读的本机文件。读不到一律记一条 note，⛔ 悄悄少一段让客服以为一切正常。
//
// 守护日志落点由主线窗口定死：`<userData>/logs/tunnel-daemon.log`（常驻守护的 stderr）。
// 非常驻时守护 stderr 继承主进程、不落盘，所以现在多数机器上没有这个文件——
// 那就如实写「未生成」，⛔ 自己造一个空文件冒充。
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface ReportFileSources {
  /** 读整个文件；不存在返回 undefined。 */
  readText(path: string): Promise<string | undefined>
  /** 读文件末尾若干字节；不存在返回 undefined。 */
  readTail(path: string, maxBytes: number): Promise<string | undefined>
}

export interface CollectOptions {
  readonly userDataPath: string
  readonly tunnelDataDir: string
  readonly files: ReportFileSources
  readonly maxLogBytes?: number
}

export interface CollectedFiles {
  readonly daemonState?: unknown
  readonly ledger?: unknown
  readonly connection?: unknown
  readonly daemonLog?: { readonly source: string; readonly lines: readonly string[] }
  /** 日志没进包的原因：'not-generated' = 文件确实不在；'unreadable' = 文件在但读不出来。
   * ⛔ 合成一种说法——「没生成」与「读不到」对客服是两件事，后者说明这台机器上有别的毛病。 */
  readonly daemonLogAbsence?: 'not-generated' | 'unreadable'
  readonly notes: readonly string[]
}

/** 守护日志的候选落点，按主线窗口定的顺序。找到第一个存在的就用它。 */
export function daemonLogCandidates(userDataPath: string, tunnelDataDir: string): readonly string[] {
  return [join(userDataPath, 'logs', 'tunnel-daemon.log'), join(tunnelDataDir, 'logs', 'tunnel-daemon.log')]
}

export async function collectLocalFiles(options: CollectOptions): Promise<CollectedFiles> {
  const notes: string[] = []
  const readJson = async (path: string, label: string): Promise<unknown> => {
    let text: string | undefined
    try { text = await options.files.readText(path) } catch (error) { notes.push(`${label} 读取失败：${errorLabel(error)}`); return undefined }
    if (text === undefined) { notes.push(`${label} 不存在`); return undefined }
    try { return JSON.parse(text) } catch { notes.push(`${label} 内容不是合法 JSON`); return undefined }
  }
  const daemonState = await readJson(join(options.tunnelDataDir, 'state.json'), '守护状态 state.json')
  const ledger = await readJson(join(options.tunnelDataDir, 'ledger.json'), '设置账本 ledger.json')
  const connection = await readJson(join(options.tunnelDataDir, 'connection-verified.json'), '复验记录 connection-verified.json')

  let daemonLog: CollectedFiles['daemonLog']
  let daemonLogAbsence: CollectedFiles['daemonLogAbsence'] = 'not-generated'
  for (const path of daemonLogCandidates(options.userDataPath, options.tunnelDataDir)) {
    let text: string | undefined
    try { text = await options.files.readTail(path, options.maxLogBytes ?? 64 * 1024) }
    catch (error) {
      // 文件在、但读不出来：这跟「没生成」是两件事，⛔ 说成同一句。
      notes.push(`守护日志读取失败：${errorLabel(error)}`)
      daemonLogAbsence = 'unreadable'
      break
    }
    if (text === undefined) continue
    // 截断处可能切在半行上，第一行不要。
    const lines = text.split('\n').slice(1).filter((line) => line.trim() !== '')
    daemonLog = { source: path, lines }
    break
  }
  if (daemonLog === undefined && daemonLogAbsence === 'not-generated') {
    notes.push('守护日志未生成（常驻守护未接入，或本次守护由工具箱主进程带起、日志没落盘）')
  }
  // 我们临时关掉的「自动检测设置」(WPAD)在账本里是一串十六进制，客服看不出那是什么。
  // 摆一句人话进注记——**不对客户说 ≠ 不留痕**：公司网络的客户报「连上之后内网打不开」时，
  // 客服得一眼看到我们动过哪几项，否则只能猜。
  for (const line of describeManagedSettings(ledger)) notes.push(line)
  return { daemonState, ledger, connection, daemonLog, ...(daemonLog ? {} : { daemonLogAbsence }), notes }
}

/** 账本里那些客服看不懂的项，给一句人话。⛔ 带原始值（那是客户机器上的设置内容）。 */
export function describeManagedSettings(ledger: unknown): readonly string[] {
  if (!Array.isArray(ledger)) return []
  const lines: string[] = []
  for (const entry of ledger) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { kind?: unknown; item?: unknown; status?: unknown }
    if (record.kind !== 'setting' || record.item !== 'DefaultConnectionSettings') continue
    const restored = record.status === 'restored' || record.status === 'preserved'
    lines.push(`系统「自动检测设置」(WPAD)：连接期间已临时关闭${restored ? '，并已还原' : '，尚未还原'}`)
  }
  return lines
}

function errorLabel(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.name : '未知原因'
}

/** 生产实现：只读、不跟随异常文件类型、只取末尾。 */
export const nodeReportFiles: ReportFileSources = {
  async readText(path) {
    try {
      const handle = await open(path, 'r')
      try { return await handle.readFile('utf8') } finally { await handle.close() }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  },
  async readTail(path, maxBytes) {
    try {
      const info = await stat(path)
      if (!info.isFile()) return undefined
      const start = Math.max(0, info.size - maxBytes)
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(maxBytes, info.size))
        await handle.read(buffer, 0, buffer.length, start)
        return buffer.toString('utf8')
      } finally { await handle.close() }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }
}
