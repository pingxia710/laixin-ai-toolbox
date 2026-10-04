/** 真时钟(常驻守护入口用):一次性定时器触发即自摘,interval 条目保留到显式清除。 */
export interface RealClock {
  now(): number
  setTimeout(fn: () => void, delayMs: number): number
  setInterval(fn: () => void, intervalMs: number): number
  clearTimer(id: number): void
  /** 仅供测试观察定时器表规模。 */
  pendingTimers(): number
}

export declare function makeRealClock(): RealClock
