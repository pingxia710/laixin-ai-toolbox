// 假适配器外包一层：每次写系统设置同步耗时（默认 250 ms），贴近真实 networksetup / 注册表写入延迟，用来逼出「恢复中」窗口。
import { createAdapter as createFake } from './fake-adapter.mjs'
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
export function createAdapter(env = process.env) {
  const inner = createFake(env)
  return { ...inner, write(ref, value) { sleep(Number(env.SLOW_ADAPTER_WRITE_MS ?? 250)); return inner.write(ref, value) } }
}
