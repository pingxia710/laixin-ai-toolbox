// 用户进程内观察网卡变化；睡眠恢复由父进程 powerMonitor 和时钟跳变共同触发。
// 不执行系统命令，不写网络配置。没有有效读数时保留上次观察，不把失败当作断网。
import { networkInterfaces } from 'node:os'

export function createPowerEventSource({ emit, interfaces = networkInterfaces, now = Date.now,
  every = setInterval, cancel = clearInterval }) {
  let previous
  let lastTick = now()
  const tick = () => {
    const time = now()
    if (time - lastTick > 5_000) emit('wake')
    lastTick = time
    try {
      const current = JSON.stringify(Object.entries(interfaces()).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, addresses]) => [name, addresses?.map(({ address, netmask, family }) => ({ address, netmask, family }))]))
      if (previous !== undefined && previous !== current) emit('network-change')
      previous = current
    } catch { /* Keep the last valid observation; periodic tunnel verification remains active. */ }
  }
  tick()
  const timer = every(tick, 2_000)
  return { stop: () => cancel(timer) }
}
