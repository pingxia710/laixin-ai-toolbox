/** 单调时钟唯一出口(缺省 performance.now;测试可注入假钟)。 */
export function monotonicNow(): number {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()
}
