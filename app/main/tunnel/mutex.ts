// 导入 / 应用 / 启动 / 停止共用一把锁(定稿第 4 轮 2):并发调用拒绝(受控码),⛔ 交错执行。
export class ActionMutex {
  private locked = false
  // 等待者队列(N-24 延伸):stop() 等锁的兜底从 200ms 自旋试锁换成 FIFO 唤醒——
  // 释放即微任务级移交,不再空转;AbortSignal 中止即出队。⛔ 让等待者与 tryAcquire 抢锁:
  // 释放时锁直接移交给队头,不出现「锁空着但有人在等」的插队窗口。
  private readonly waiters: Array<{
    readonly grant: (release: () => void) => void
    readonly reject: (error: Error) => void
    readonly onAbort: () => void
    readonly signal: AbortSignal
  }> = []

  tryAcquire(): (() => void) | undefined {
    if (this.locked) {
      return undefined
    }
    this.locked = true
    return this.makeRelease()
  }

  /** 等待者路径:空闲立即得手;被持有时排队,release 按 FIFO 唤醒。
   *  signal 中止(如 10s 兜底 deadline)在拿到锁之前生效:出队并拒绝;
   *  已拿到锁之后的中止不追回——锁在调用方手里,由调用方照常释放。 */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    const immediate = this.tryAcquire()
    if (immediate !== undefined) return immediate
    if (signal?.aborted) throw new Error('MUTEX_WAIT_ABORTED')
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index < 0) return // 已出队(拿到锁或已放弃),中止不追回
        this.waiters.splice(index, 1)
        reject(new Error('MUTEX_WAIT_ABORTED'))
      }
      const waiter = {
        grant: (release: () => void) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(release)
        },
        reject,
        onAbort,
        signal: signal ?? new AbortController().signal
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  isLocked(): boolean {
    return this.locked
  }

  /** 释放:有等待者就把锁直接移交给队头(locked 保持,无缝);没有才真正放开。重复释放幂等。 */
  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next !== undefined) next.grant(this.makeRelease())
      else this.locked = false
    }
  }
}

export const MUTEX_BUSY_CODE = 'TUNNEL_BUSY'
