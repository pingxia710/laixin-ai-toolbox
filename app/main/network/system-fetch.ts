// N-81:账号后台/网络配置请求的缺省出口走 Electron 网络栈——客户的系统代理/PAC/WinINET
// (含已连接状态下指向来信桥的系统代理)都算数,与浏览器同一条路,消灭「浏览器能通、
// 工具箱账号/领取请求不通」。非 Electron 进程(测试/工具)退回全局 fetch,与 INV-01 的
// registryFetch 同款。「独立于来信隧道」指代码路径不依赖通道件(⛔ 这里绝不显式走桥、
// 绝不改系统设置、⛔ 无条件直连回退):系统代理此刻指向什么就诚实用什么,残死代理由
// 既有的恢复/修复链处理,传输层只负责如实成功或如实失败。
export async function systemFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (process.versions.electron === undefined) return fetch(input, init)
  try {
    const electron = await import('electron')
    if (typeof electron.net?.fetch === 'function') return electron.net.fetch(input as string | Request, init)
  } catch { /* 见下方降级说明。 */ }
  // 显式兼容性降级路径(⛔ 不是产品行为):仅在 Electron 环境下 net.fetch 缺失/不可调用
  // (异常构建、启动早期)时兜底,保证账号功能可用性优先;正常生产 Electron 恒走系统栈。
  return fetch(input, init)
}
