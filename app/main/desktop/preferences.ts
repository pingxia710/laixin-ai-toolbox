import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DesktopPreferences } from '../../desktop-types'

export interface WindowBounds { x: number; y: number; width: number; height: number }
interface SavedDesktopState extends DesktopPreferences { bounds?: WindowBounds; maximized?: boolean; notified?: string[]
  /** 「工具箱意外退出时网络不断」:⛔ 并进 DesktopPreferences——那一组是 configure() 一次性写的,
   *  这一项要单独读写(关掉时要当场把已装的常驻撤掉,⛔ 跟缩放、提醒挤在一次保存里)。 */
  keepNetworkWhenClosed?: boolean
  /** FB-1:连接失败时自动回传故障类型。同样单独读写:消费方(tunnel 回传)按需读,不走 configure。 */
  failureReport?: boolean }
export const zoomLevels = [1, 1.1, 1.25, 1.5] as const
/** FB-1 回传开关的缺省:开(工作单技术层决定)。默认值是产品取舍,⛔ 埋进「没选过」里。 */
export const FAILURE_REPORT_DEFAULT_ENABLED = true

export function visibleBounds(saved: WindowBounds | undefined, displays: readonly WindowBounds[]): WindowBounds | undefined {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) || saved.width < 620 || saved.height < 420) return undefined
  const display = displays.find((area) => Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x) >= 100 &&
    Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y) >= 100)
  if (!display) return undefined
  const width = Math.min(saved.width, display.width), height = Math.min(saved.height, display.height)
  return { width, height, x: Math.max(display.x, Math.min(saved.x, display.x + display.width - width)),
    y: Math.max(display.y, Math.min(saved.y, display.y + display.height - height)) }
}

// 窗口 resize/move 每事件写盘的防抖等待;期间内存已有最新值,退出时仍同步保存兜底。
export const WINDOW_SAVE_DEBOUNCE_MS = 300

export interface Debounced<Self extends unknown[]> {
  (...args: Self): void
  cancel(): void
}

export function debounce<Self extends unknown[]>(fn: (...args: Self) => void, waitMs: number, schedule: typeof setTimeout = setTimeout): Debounced<Self> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (...args: Self): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = schedule(() => { timer = undefined; fn(...args) }, waitMs)
  }
  debounced.cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  return debounced
}

export class DesktopStore {
  private state: SavedDesktopState = { zoom: 1, quotaNotifications: true, autoUpdate: true, notified: [] }
  // 落盘代次:每次状态变更 +1,异步写据此判断自己是否已被更新的写超越。
  private generation = 0
  // 异步写串行化:防抖写彼此之间也会交错,⛔ 让先发的后落。
  private writeChain: Promise<void> = Promise.resolve()
  private sequence = 0
  constructor(private readonly file: string) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedDesktopState
      this.state = { zoom: zoomLevels.includes(saved.zoom as typeof zoomLevels[number]) ? saved.zoom : 1,
        quotaNotifications: typeof saved.quotaNotifications === 'boolean' ? saved.quotaNotifications : true,
        autoUpdate: typeof saved.autoUpdate === 'boolean' ? saved.autoUpdate : true,
        keepNetworkWhenClosed: typeof saved.keepNetworkWhenClosed === 'boolean' ? saved.keepNetworkWhenClosed : undefined,
        failureReport: typeof saved.failureReport === 'boolean' ? saved.failureReport : undefined,
        bounds: saved.bounds, maximized: saved.maximized === true,
        notified: Array.isArray(saved.notified) ? saved.notified.filter((key): key is string => typeof key === 'string').slice(-200) : [] }
    } catch { /* An absent or invalid preference file uses the visible default window. */ }
  }
  preferences(): DesktopPreferences { return { zoom: this.state.zoom, quotaNotifications: this.state.quotaNotifications, autoUpdate: this.state.autoUpdate } }
  window(): Pick<SavedDesktopState, 'bounds' | 'maximized'> { return { bounds: this.state.bounds, maximized: this.state.maximized } }
  /** 客户对「工具箱意外退出时网络不断」的选择;没选过返回 undefined —— 默认值是产品取舍,⛔ 埋在存储里。 */
  residentChoice(): boolean | undefined { return this.state.keepNetworkWhenClosed }
  setResidentChoice(enabled: boolean): void { this.save({ keepNetworkWhenClosed: enabled }) }
  /** FB-1 回传开关的存储读写;缺省(没选过)返回 undefined,由调用方套 FAILURE_REPORT_DEFAULT_ENABLED。 */
  failureReportChoice(): boolean | undefined { return this.state.failureReport }
  setFailureReportChoice(enabled: boolean): void { this.save({ failureReport: enabled }) }
  notified(key: string): boolean { return this.state.notified?.includes(key) === true }
  rememberNotification(key: string): void { this.save({ notified: [...(this.state.notified ?? []), key].slice(-200) }) }
  save(patch: Partial<SavedDesktopState>): void {
    // 先落内存再写盘:代次随之推进,任何还在 await 里的异步写都会认出自己已过期。
    const next = this.validated(patch)
    this.state = next
    this.generation += 1
    this.writeStateSync()
  }

  /** 把当下的 state 同步落盘。同步写中间不让出事件循环,⛔ 被任何异步写插进来。 */
  private writeStateSync(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = this.temporaryPath()
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(temporary, this.file)
  }

  /** 异步落盘:高频调用(窗口 resize/move 防抖后)不再阻塞主进程。 */
  async saveAsync(patch: Partial<SavedDesktopState>): Promise<void> {
    // 旧写法在函数入口就把 next 算好,然后一路 await;期间关窗走同步 save 写了新位置,
    // 这一次收尾时又把旧 state 盖回去 ⇒ 窗口位置回退、maximized 键整个消失,且不报错。
    // 现在:补丁立刻合进内存,真正写盘时才序列化当下的 state,并按代次判自己是不是最后一个。
    const next = this.validated(patch)
    this.state = next
    const generation = (this.generation += 1)
    const write = this.writeChain.then(async () => {
      // 期间已有更新的状态写过(同步 save)或正排在后面:这一次作废,⛔ 拿旧快照盖新值。
      if (generation !== this.generation) return
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = this.temporaryPath()
      // 代次要取「序列化那一刻」的值——临时文件里装的就是这一刻的 state。
      const snapshot = this.generation
      await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 })
      // 写盘到落位之间同样是竞态窗口:关窗的同步 save 正好落在这里时,临时文件里已是旧内容,
      // rename 会把刚写好的新位置盖回去(压力实测约四分之一命中)。⛔ 只在链头判一次。
      if (snapshot !== this.generation) { await rm(temporary, { force: true }); return }
      await rename(temporary, this.file)
      // rename 本身也要等:它在途时同步 save 可能刚写完新内容,又被我们这一次盖掉。
      // 真撞上就拿当下的 state 同步补一次——同步写不会再让出事件循环,不会再起一轮。
      if (snapshot !== this.generation) this.writeStateSync()
    })
    // 链本身不能因为一次失败断掉,但调用方仍要拿到这次的错误。
    this.writeChain = write.catch(() => undefined)
    await write
  }

  // 每次写自己的临时文件:同步 save 与在途异步写共用一个名字时,两边会互相截断。
  private temporaryPath(): string {
    this.sequence += 1
    return `${this.file}.${process.pid}.${this.sequence}.tmp`
  }

  private validated(patch: Partial<SavedDesktopState>): SavedDesktopState {
    if (patch.zoom !== undefined && !zoomLevels.includes(patch.zoom as typeof zoomLevels[number])) throw new Error('DESKTOP_ZOOM_INVALID')
    return { ...this.state, ...patch }
  }
}
