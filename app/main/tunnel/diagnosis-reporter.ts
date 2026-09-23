// FB-1:连接失败终态回传的发送与攒批。只经手白名单六字段(失败码/阶段/平台/客户端版本/
// 授权 ID/时间戳),⛔ IP、地址、进程名、配置内容、客户机器上的任何文本——自动回传必须比
// 客户主动点的一键上报更窄。后台不可达时本地攒队列(上限 50 条、7 天),下次启动补传;
// 判不出原因的失败在上游记 UNKNOWN+阶段,这里只管把给到的东西原样送出去。
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './paths'

export type DiagnosisStage = 'connect-start' | 'connect-run' | 'repair'

export interface DiagnosisReport {
  readonly code: string
  readonly stage: DiagnosisStage
  /** 空串 = 没有已导入配置(很多失败发生在导入之前)。 */
  readonly authorizationId?: string
}

export interface DiagnosisPayload {
  readonly code: string
  readonly stage: DiagnosisStage
  readonly platform: string
  readonly clientVersion: string
  readonly authorizationId: string
  readonly timestamp: number
}

/** send 抛错时带 diagnosisPermanent = 该失败不是「通道一时不通」:
 * 'auth' = 会话过期(补传也 401),'route' = 老后台没有这个端点。两类都不入队空转。 */
export interface DiagnosisSendError {
  diagnosisPermanent?: 'auth' | 'route'
}

export interface DiagnosisReporterDeps {
  readonly send: (payload: DiagnosisPayload) => Promise<void>
  /** 设置页开关;关掉时直传与入队都断(工作单验收:正向与反向都断)。 */
  readonly enabled: () => boolean
  readonly platform: string
  readonly version: () => string
  readonly now: () => number
  readonly queuePath: string
}

export const DIAGNOSIS_QUEUE_LIMIT = 50
export const DIAGNOSIS_MAX_AGE_MS = 7 * 24 * 60 * 60_000

export class DiagnosisReporter {
  private flushing = false
  /** 队列「读全量→改→写回」的串行链,enqueue 与 flush 排进同一条:flush 持本地快照在
   * await send 挂起期间,中途入队若直接落盘,flush 恢复后会用旧快照整体覆盖——那条记录
   * 从未发送就从盘上消失。链自身永不拒绝:一步失败不堵下一步。 */
  private queueTail: Promise<void> = Promise.resolve()

  constructor(private readonly deps: DiagnosisReporterDeps) {}

  /** 失败终态入口。同步返回,发送与入队的异常一律就地吞掉——回传 ⛔ 影响连接动作本身。 */
  report(report: DiagnosisReport): void {
    if (!this.deps.enabled()) return
    const code = report.code
    if (code === '') return
    const payload: DiagnosisPayload = {
      code, stage: report.stage, platform: this.deps.platform,
      clientVersion: this.deps.version(), authorizationId: report.authorizationId ?? '',
      timestamp: this.deps.now()
    }
    void this.deps.send(payload).catch((error: unknown) => {
      if ((error as DiagnosisSendError)?.diagnosisPermanent !== undefined) return
      void this.serialized(() => this.enqueue(payload)).catch(() => { /* 攒批失败只能放弃这一条;⛔ 让它冒成主进程未处理拒绝 */ })
    })
  }

  /** 启动/拿到会话后的补传。按序发,一条失败即停(通道不通时条条不通,⛔ 雪崩式重试);
   * 过期条目先丢。进行中重复调用直接让位。整个读-发-写回在串行链内,中途入队排在 flush 之后。 */
  async flushPending(): Promise<void> {
    if (this.flushing || !this.deps.enabled()) return
    this.flushing = true
    try {
      await this.serialized(async () => {
        const queue = this.readQueue().filter((entry) => this.deps.now() - entry.timestamp <= DIAGNOSIS_MAX_AGE_MS)
        while (queue.length > 0) {
          const payload = queue[0]
          try {
            await this.deps.send(payload)
          } catch (error: unknown) {
            if ((error as DiagnosisSendError)?.diagnosisPermanent === 'route') {
              // 老后台没有端点:留着这批,后台升级后(7 天内)还有价值;本轮回发就此打住。
              this.writeQueue(queue)
              return
            }
            this.writeQueue(queue) // 会话过期或通道不通:整批原样保留
            return
          }
          queue.shift()
          this.writeQueue(queue)
        }
      })
    } finally {
      this.flushing = false
    }
  }

  private serialized<T>(op: () => T | Promise<T>): Promise<T> {
    const result = this.queueTail.then(op)
    this.queueTail = result.then(() => undefined, () => undefined)
    return result
  }

  private enqueue(payload: DiagnosisPayload): void {
    const queue = this.readQueue()
    queue.push(payload)
    // 满了丢最旧:最早的诊断对「下一版修什么」的参考价值最低,⛔ 因此丢掉失败事实本身。
    this.writeQueue(queue.slice(-DIAGNOSIS_QUEUE_LIMIT))
  }

  private readQueue(): DiagnosisPayload[] {
    if (!existsSync(this.deps.queuePath)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.deps.queuePath, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((entry): entry is DiagnosisPayload => {
        const item = entry as Partial<DiagnosisPayload> | null
        return item !== null && typeof item.code === 'string' && typeof item.stage === 'string' &&
          typeof item.platform === 'string' && typeof item.clientVersion === 'string' &&
          typeof item.authorizationId === 'string' && Number.isSafeInteger(item.timestamp)
      })
    } catch { return [] }
  }

  private writeQueue(queue: readonly DiagnosisPayload[]): void {
    writeFileAtomic(this.deps.queuePath, `${JSON.stringify(queue, null, '')}\n`)
  }
}
