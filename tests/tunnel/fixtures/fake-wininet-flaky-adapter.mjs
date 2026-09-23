// 假 WinINET 适配器的「前 N 次写必败」包装(甲-2 恢复梯子用例的故障注入):
// 杀软短暂锁住注册表的形状——写几次之后自己松开。N 由 FAKE_WININET_FLAKY_FAIL_FIRST 给,
// 缺省 0(不注入)。写动作流水由被包装的假适配器记进 <store>.ops.jsonl,用例据此数尝试次数。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAdapter as createBase } from './fake-wininet-adapter.mjs'

export function createAdapter(env = process.env) {
  const base = createBase(env)
  const failFirst = Number.parseInt(env.FAKE_WININET_FLAKY_FAIL_FIRST ?? '0', 10)
  const storePath = env.FAKE_WININET_STORE
  // 甲-2 返工:模拟「梯子睡眠窗口的中途,新守护接手同一数据目录」——旧账结清、写下新守护
  // 自己的代理设置、意图文件变成 connected。三个动作都在注入时刻直接落盘(与用例种子同一
  // 先例),由本进程的真实定时器触发,正好落在恢复梯子的睡眠里。
  const takeoverAt = Number.parseInt(env.FAKE_WININET_FLAKY_TAKEOVER_MS ?? '0', 10)
  const takeoverDataDir = env.FAKE_WININET_TAKEOVER_DATADIR
  if (Number.isFinite(takeoverAt) && takeoverAt > 0 && typeof takeoverDataDir === 'string' && takeoverDataDir !== '' &&
      typeof storePath === 'string' && storePath !== '') {
    setTimeout(() => {
      const ledgerPath = join(takeoverDataDir, 'ledger.json')
      const entries = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      const settled = entries.map((entry) => entry.kind === 'setting' ? { ...entry, status: 'restored', note: '' } : entry)
      settled.push({
        id: 'w-takeover-1', kind: 'setting', service: 'WinINET', item: 'ProxyServer',
        originalValue: null, writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18081' },
        sessionToken: 'takeover-daemon', time: Date.now(), status: 'applied', note: ''
      })
      writeFileSync(ledgerPath, `${JSON.stringify(settled, null, 1)}\n`)
      writeFileSync(join(takeoverDataDir, 'intent.json'), `${JSON.stringify({ desired: 'connected', sessionToken: 'takeover-daemon' })}\n`)
      const store = JSON.parse(readFileSync(storePath, 'utf8'))
      store.ProxyServer = { type: 'REG_SZ', data: '127.0.0.1:18081' }
      writeFileSync(storePath, JSON.stringify(store))
    }, takeoverAt)
  }
  let attempts = 0
  return {
    ...base,
    // 写入权注入与 fake-adapter.mjs 同形:设了 FAKE_WRITE_RIGHT 才暴露这个方法('held' = 权被别人占着)。
    ...(env.FAKE_WRITE_RIGHT === undefined ? {} : {
      acquireWriteRight: () => {
        if (env.FAKE_WRITE_RIGHT === 'held') return { acquired: false, reason: 'held' }
        return { acquired: true, abandoned: env.FAKE_WRITE_RIGHT === 'abandoned', release: () => undefined }
      }
    }),
    write: (ref, value) => {
      attempts += 1
      if (Number.isFinite(failFirst) && attempts <= failFirst) {
        // 注入的失败也要进操作流水(与被包装的假适配器同格)——用例按流水数尝试次数。
        if (typeof storePath === 'string' && storePath !== '') {
          appendFileSync(`${storePath}.ops.jsonl`, `${JSON.stringify({ op: 'write-failed', key: ref.item, value, time: Date.now() })}\n`)
        }
        throw new Error('temporary registry lock')
      }
      return base.write(ref, value)
    }
  }
}
