// 常驻校准落定闸门(甲-1 返工):开机接续和等待期的手动连接都排在这里,
// 校准落定(装上/没装上/卸下/抛错,任何结果)后统一补做 —— 任何校准结果都不能让接续永远等下去。
// 从 actions/tunnel 的生产闭包里抽成独立小函数,让四条契约各有用例钉着:
//   1) 落定前登记的,落定后执行且只执行一次;2) 落定后登记的,立即执行;
//   3) 一个补做抛错不挡其余;4) 校准落定只生效一次(跑两次不重复执行)。
export interface CalibrationGate {
  /** 校准落定后执行 fn;已落定则立即执行。 */
  afterCalibration(fn: () => void): void
  /** 校准落定(无论结果如何):排队的接续统一补做。只第一次生效。 */
  markCalibrated(): void
  /** 是否已落定。 */
  readonly calibrated: boolean
}

export function createCalibrationGate(): CalibrationGate {
  let calibrated = false
  let waiters: Array<() => void> = []
  return {
    afterCalibration: (fn) => {
      if (calibrated) {
        fn()
        return
      }
      waiters.push(fn)
    },
    markCalibrated: () => {
      if (calibrated) return
      calibrated = true
      // 先清队列再逐个执行:补做里再登记的(等待期的手动连接)走「已落定 → 立即执行」,⛔ 排进死队列。
      const pending = waiters
      waiters = []
      for (const waiter of pending) {
        try { waiter() } catch { /* 一个接续补做失败不挡其余的 */ }
      }
    },
    get calibrated() { return calibrated }
  }
}
