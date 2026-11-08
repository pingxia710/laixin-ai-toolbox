// 资源占用快照:只取本进程可真实读到的量。句柄数用 process._getActiveHandles 近似
// (平台边界:mac/win 计数口径差异,标注在报告);CPU 时间在 CI 噪声下不稳定,⛔ 采集。


export interface ResourceSnapshot { rssBytes: number; heapUsedBytes: number; handles: number | null; /** process.resourceUsage() 原始对象(只作诊断展示,不入分位);取不到为 null。 */ usage: unknown }

export function resourceSnapshot(): ResourceSnapshot | null {
  try {
    const memory = process.memoryUsage()
    // 内部 API,带防御:拿不到就 null(⛔ 拿 0 冒充读数)。
    const handles = typeof (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles === 'function'
      ? (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles().length : null
    const usage: unknown = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null
    return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, handles, usage }
  } catch {
    return null
  }
}
