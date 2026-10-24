// 记录型假适配器(N-23):包装 fake-adapter,额外暴露会记录 timeoutMs 的 acquireWriteRight。
// 用来钉住「一次性恢复子进程拿写权是有界等待,不是 0 秒抢」。
import { appendFileSync } from 'node:fs'
import { createAdapter as createFake } from './fake-adapter.mjs'

export function createAdapter(env = process.env) {
  const inner = createFake(env)
  const opsPath = `${String(env.FAKE_ADAPTER_STORE)}.ops.jsonl`
  return {
    ...inner,
    acquireWriteRight: ({ timeoutMs } = {}) => {
      appendFileSync(opsPath, `${JSON.stringify({ op: 'acquireWriteRight', key: 'timeoutMs', value: timeoutMs ?? null, time: Date.now() })}\n`)
      if (env.FAKE_WRITE_RIGHT_ACQUIRED === '1') {
        return { acquired: true, abandoned: false, release: () => undefined }
      }
      return { acquired: false, reason: 'held' }
    }
  }
}
