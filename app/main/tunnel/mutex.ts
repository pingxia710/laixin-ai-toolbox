// 导入 / 应用 / 启动 / 停止共用一把锁(定稿第 4 轮 2):并发调用拒绝(受控码),⛔ 交错执行。
export class ActionMutex {
  private locked = false

  tryAcquire(): (() => void) | undefined {
    if (this.locked) {
      return undefined
    }
    this.locked = true
    return () => {
      this.locked = false
    }
  }

  isLocked(): boolean {
    return this.locked
  }
}

export const MUTEX_BUSY_CODE = 'TUNNEL_BUSY'
