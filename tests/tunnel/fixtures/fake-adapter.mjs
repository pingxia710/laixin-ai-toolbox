// 假系统设置适配器(判据 1/4 与全部逻辑层测试):状态落在 FAKE_ADAPTER_STORE 指向的
// JSON 文件(模拟「系统设置」的磁盘读数),操作流水追加到 <store>.ops.jsonl。
// 故障注入:FAKE_ADAPTER_FAILURES = {"write":[{"key":"服务/项","whenValue":<json>,"message":"..."}]}
// 该适配器只做内存与临时文件读写,不触任何系统命令。
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export function createAdapter(env = process.env) {
  // 设了 FAKE_WRITE_RIGHT 时,每一次写都必须发生在持权期间(见下方 write 的守卫)。
  let writeRightHeld = false
  const storePath = env.FAKE_ADAPTER_STORE
  if (typeof storePath !== 'string' || storePath === '') {
    throw new Error('FAKE_ADAPTER_STORE 未设置')
  }
  const failures = JSON.parse(env.FAKE_ADAPTER_FAILURES ?? '{"write":[]}')
  const opsPath = `${storePath}.ops.jsonl`
  // 网络服务清单(D5):默认静态;指到一个文件时每次现读,用来模拟网卡/VPN/蓝牙 PAN
  // 在连接过程中出现或消失。读一个已经不在清单里的服务 = 目标已不存在,与真实适配器同码。
  const servicesFile = env.FAKE_ADAPTER_SERVICES_FILE
  const listServices = () => {
    const raw = servicesFile
      ? (existsSync(servicesFile) ? readFileSync(servicesFile, 'utf8') : '')
      : (env.FAKE_ADAPTER_SERVICES ?? 'Wi-Fi')
    return raw.split(',').map((name) => name.trim()).filter((name) => name !== '')
  }
  const requireService = (service) => {
    if (servicesFile === undefined) return
    if (listServices().includes(service)) return
    throw Object.assign(new Error(`网络服务「${service}」已不存在`), { code: 'TUNNEL_SETTING_TARGET_ABSENT' })
  }

  const load = () => (existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {})
  // 原子写(临时文件 + rename):守护子进程在写这份假设置,父进程的 waitFor 同时在轮询读它。
  // 直接 writeFileSync 会先截断再写,读者撞进那个窗口就读到半截 JSON——表现是「高负载下偶发假红」,
  // 实际是读写竞争、条件具备就必现。生产代码这一块(paths.writeFileAtomic / daemon-core.writeState)
  // 一直是原子的,⛔ 唯独夹具不是。
  const save = (store) => {
    const temporary = `${storePath}.tmp-${randomBytes(4).toString('hex')}`
    writeFileSync(temporary, JSON.stringify(store, null, 1))
    renameSync(temporary, storePath)
  }
  const log = (op, key, value) =>
    appendFileSync(opsPath, `${JSON.stringify({ op, key, value, time: Date.now() })}\n`)

  return {
    // 系统代理写入权(2026-09-15):**只有设置了 FAKE_WRITE_RIGHT 才暴露这个方法**——
    // 不设置时适配器没有它,守护按「平台不提供、无需协调」走原路径,既有用例行为一字不变。
    //   held      = 被别人持着,一个字节都不许写
    //   abandoned = 拿到了,但前任是崩掉的
    //   (其他)    = 正常拿到
    ...(env.FAKE_WRITE_RIGHT === undefined ? {} : {
      acquireWriteRight: () => {
        if (env.FAKE_WRITE_RIGHT === 'held') return { acquired: false, reason: 'held' }
        writeRightHeld = true
        return {
          acquired: true,
          abandoned: env.FAKE_WRITE_RIGHT === 'abandoned',
          release: () => { writeRightHeld = false }
        }
      }
    }),
    managedItems(proxy) {
      log('managedItems', 'proxy', proxy)
      return listServices().map((service) => ({
        ref: { service, item: 'socks-proxy' },
        value: { enabled: true, host: proxy.host, port: proxy.port }
      }))
    },
    // 连接前的所有权判断:已启用且不是我们要写的地址 ⇒ 第三方代理软件在管,报冲突。
    // 与真实 mac 适配器同形(发布审查 R4):已有代理不再是拒绝理由,只报出来给守护判「能出外网就复用,否则接管」。
    preflight() {},
    existingProxy(ours) {
      const store = load()
      const isOurs = (value) => value.host === ours?.host && (value.port === ours?.port || (value.host === '127.0.0.1' && /^18[0-9]80$/.test(String(value.port))))
      for (const service of listServices()) {
        for (const item of ['web-proxy', 'secure-web-proxy', 'socks-proxy']) {
          const current = store[`${service}/${item}`]
          if (current?.enabled !== true || isOurs(current)) continue
          return { kind: item === 'socks-proxy' ? 'socks' : 'http', host: current.host, port: current.port, source: `${service}/${item}` }
        }
      }
      return undefined
    },
    read(itemRef) {
      requireService(itemRef.service)
      const key = `${itemRef.service}/${itemRef.item}`
      const store = load()
      log('read', key, store[key] ?? null)
      return store[key] ?? null
    },
    write(itemRef, value) {
      // 守卫:任何**权外写**直接失败。它抓的是竞态——权已经交还之后才写(例如残留清理
      // 跑在 withWriteRight 回调之外),那一瞬另一实例可能已经抢到权。
      // ⛔ 只靠「拿不到权时不写」的断言:那条路径会提前 return,根本走不到写入,测了个寂寞。
      if (env.FAKE_WRITE_RIGHT !== undefined && !writeRightHeld) {
        throw Object.assign(new Error(`在没有系统代理写入权的情况下写 ${itemRef.service}/${itemRef.item}`), { code: 'WRITE_WITHOUT_RIGHT' })
      }
      requireService(itemRef.service)
      const key = `${itemRef.service}/${itemRef.item}`
      const rule = (failures.write ?? []).find(
        (candidate) =>
          candidate.key === key &&
          (candidate.whenValue === undefined ||
            JSON.stringify(candidate.whenValue) === JSON.stringify(value))
      )
      if (rule !== undefined) {
        log('write-failed', key, value)
        throw new Error(rule.message ?? '假适配器写失败')
      }
      const store = load()
      if (value === null) {
        delete store[key]
      } else {
        store[key] = value
      }
      save(store)
      log('write', key, value)
    }
  }
}
