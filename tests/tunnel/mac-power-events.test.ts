import { expect, it, vi } from 'vitest'
import { createPowerEventSource } from '../../sidecar/mac/power-events.mjs'

it('Mac 网卡变化与睡眠后的时钟跳变触发复验；读取失败保留旧观察，关闭释放定时器', () => {
  let tick = () => {}
  let time = 0
  let address = '192.0.2.1'
  let readFails = false
  const emit = vi.fn()
  const cancel = vi.fn()
  const source = createPowerEventSource({ emit, now: () => time, interfaces: () => {
    if (readFails) throw new Error('unavailable')
    return { en0: [{ address, family: 'IPv4', netmask: '255.255.255.0', internal: false, mac: '00:00:00:00:00:00', cidr: `${address}/24` }] }
  }, every: (callback) => { tick = callback; return 1 }, cancel })
  tick(); expect(emit).not.toHaveBeenCalled()
  address = '192.0.2.2'; tick()
  expect(emit).toHaveBeenLastCalledWith('network-change')
  time = 6000; tick()
  expect(emit).toHaveBeenLastCalledWith('wake')
  readFails = true; tick(); readFails = false; tick()
  expect(emit).toHaveBeenCalledTimes(2)
  source.stop(); expect(cancel).toHaveBeenCalledWith(1)
})
