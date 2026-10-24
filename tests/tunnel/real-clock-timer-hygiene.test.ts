// P2(网络数据面优化):makeRealClock 的 timers Map 泄漏。register 只 set、仅 clearTimer delete,
// 一次性定时器自然到期后条目永驻——常驻守护按周跑,Map 只增不减。修后:一次性定时器触发即自摘;
// interval 条目保留到显式清除。变异自证:去掉触发时的 delete → 本用例红。
import { expect, it } from 'vitest'
import { makeRealClock } from '../../sidecar/win/tunnel-daemon.mjs'
import { waitFor } from './helpers'

it('一次性定时器触发后自清,interval 条目在显式清除前保留', async () => {
  const clock = makeRealClock()
  let fired = false
  clock.setTimeout(() => { fired = true }, 5)
  await waitFor(() => fired, 5_000)
  expect(clock.pendingTimers()).toBe(0)
  const interval = clock.setInterval(() => undefined, 60_000)
  expect(clock.pendingTimers()).toBe(1)
  clock.clearTimer(interval)
  expect(clock.pendingTimers()).toBe(0)
  // 未知 id 的 clear 是 no-op;模块被 import ⛔ 触发 main(否则本用例进程早已 exit 64)。
  clock.clearTimer(999_999)
  expect(clock.pendingTimers()).toBe(0)
}, 15_000)
