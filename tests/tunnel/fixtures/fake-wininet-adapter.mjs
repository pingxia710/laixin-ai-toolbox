// 假 WinINET 适配器(win 守护逻辑层测试专用):模拟当前用户 Internet Settings 四键的
// 注册表读数,决策逻辑与真实 adapter-wininet.mjs 同形(策略锁 / 冲突 / ProxyOverride 合并),
// 但只做临时文件读写,⛔ 不触任何系统命令。操作流水追加到 <store>.ops.jsonl。
// 故障注入:FAKE_WININET_FAILURES = {"write":[{"key":"ProxyServer","whenValue":{...},"message":"..."}]}
// 策略锁注入:FAKE_WININET_POLICY = '1' ⇒ preflight 一律按「受管理环境」拒。
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { ConnectorError, CONTROL_CODES } from '../../../sidecar/win/connectors.mjs'
import { parseProxyServer, wininetValuesEqual } from '../../../sidecar/win/wininet-values.mjs'
import { isOurProxy } from '../../../sidecar/win/proxy-identity.mjs'
import { autoDetectManagedItem } from '../../../sidecar/win/connection-settings.mjs'

const CONNECTION_ITEM = 'DefaultConnectionSettings'
const ITEMS = ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL', CONNECTION_ITEM]
const LOCAL_BYPASS = ['<local>', 'localhost', '127.*']

export function createAdapter(env = process.env) {
  const storePath = env.FAKE_WININET_STORE
  if (typeof storePath !== 'string' || storePath === '') {
    throw new Error('FAKE_WININET_STORE 未设置')
  }
  const failures = JSON.parse(env.FAKE_WININET_FAILURES ?? '{"write":[]}')
  const opsPath = `${storePath}.ops.jsonl`

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

  const read = (ref) => {
    if (ref.service !== 'WinINET' || !ITEMS.includes(ref.item)) {
      throw new Error(`WININET_ITEM_INVALID:${ref.service}/${ref.item}`)
    }
    const store = load()
    log('read', ref.item, store[ref.item] ?? null)
    return store[ref.item] ?? null
  }

  const write = (ref, value) => {
    if (ref.service !== 'WinINET' || !ITEMS.includes(ref.item)) {
      throw new Error(`WININET_ITEM_INVALID:${ref.service}/${ref.item}`)
    }
    const rule = (failures.write ?? []).find(
      (candidate) =>
        candidate.key === ref.item &&
        (candidate.whenValue === undefined ||
          JSON.stringify(candidate.whenValue) === JSON.stringify(value))
    )
    if (rule !== undefined) {
      log('write-failed', ref.item, value)
      throw new Error(rule.message ?? '假适配器写失败')
    }
    const store = load()
    if (value === null) {
      delete store[ref.item]
    } else {
      store[ref.item] = value
    }
    save(store)
    log('write', ref.item, value)
  }

  return {
    valuesEqual: wininetValuesEqual,
    // 与真实 adapter-wininet.mjs 同形:电脑上别的代理正开着吗(⛔ 把我们自己写的算成别人的)。
    // 守护据此决定「能出外网就复用」还是接管,以及争抢时该不该让位。
    existingProxy(ours) {
      const store = load()
      const pac = store.AutoConfigURL
      if (pac != null && pac.data !== '') return { kind: 'pac', url: pac.data, source: 'WinINET/AutoConfigURL' }
      if (store.ProxyEnable?.data !== '1') return undefined
      const parsed = parseProxyServer(store.ProxyServer?.data ?? '')
      if (parsed === undefined) return undefined
      // 与生产适配器共用同一份判据,⛔ 夹具自己再写一份(松一档就会测出一档假的绿)。
      const isOurs = isOurProxy(parsed, ours)
      return isOurs ? undefined : { ...parsed, source: 'WinINET/ProxyServer' }
    },
    preserveExternalChanges: (ref) => ref.service === 'WinINET' && ITEMS.includes(ref.item),
    reapplyOnChange: (ref) => ref.service === 'WinINET' && ITEMS.includes(ref.item),
    preflight(proxy) {
      if (env.FAKE_WININET_POLICY === '1') {
        throw new ConnectorError(CONTROL_CODES.managedPolicy, '系统代理受组织策略管理')
      }
      const ours = `127.0.0.1:${String(proxy.port)}`
      log('preflight', 'ok', ours)
    },
    managedItems(proxy) {
      const store = load()
      const override = store.ProxyOverride?.data ?? ''
      const seen = new Set()
      const entries = []
      for (const value of [...override.split(';'), ...LOCAL_BYPASS]) {
        const trimmed = value.trim()
        const key = trimmed.toLowerCase()
        if (trimmed !== '' && !seen.has(key)) {
          seen.add(key)
          entries.push(trimmed)
        }
      }
      // 与真实 adapter-wininet.mjs 同形:先 Server 后 Enable,恢复(账本逆序)时反过来。
      const items = [
        { ref: { service: 'WinINET', item: 'ProxyServer' }, value: { type: 'REG_SZ', data: `127.0.0.1:${String(proxy.port)}` } },
        { ref: { service: 'WinINET', item: 'ProxyEnable' }, value: { type: 'REG_DWORD', data: '1' } },
        { ref: { service: 'WinINET', item: 'ProxyOverride' }, value: { type: 'REG_SZ', data: entries.join(';') } },
        { ref: { service: 'WinINET', item: 'AutoConfigURL' }, value: null }
      ]
      // 「自动检测设置」(WPAD)与生产适配器共用同一份判断,⛔ 夹具再复刻一遍。
      const autoDetect = autoDetectManagedItem(store[CONNECTION_ITEM] ?? null, { service: 'WinINET', item: CONNECTION_ITEM })
      if (autoDetect !== undefined) items.push(autoDetect)
      log('managedItems', 'proxy', proxy)
      return items
    },
    read,
    write,
    broadcastSettingsChanged() {
      log('broadcast', 'settings-changed', null)
      // 故障注入(W2-1 回落检查用例):模拟 Windows 对代理相关值的连带规范化——
      // 每次变更通知都把 blob 重写成「规范化形态」(autoDetect 位被清、DIRECT 位置位、counter 跳变、变长)。
      // 按字节算(blob 是小端),⛔ parseInt 整份 hex 当数算——那是大端语义,位全错。
      if (env.FAKE_WININET_NORMALIZE_BLOB !== '1') return
      const store = load()
      const blob = store[CONNECTION_ITEM]
      if (blob?.type !== 'REG_BINARY') return
      const bytes = []
      for (let i = 0; i < blob.data.length; i += 2) bytes.push(Number.parseInt(blob.data.slice(i, i + 2), 16))
      if (bytes.length < 12) return
      bytes[4] = (bytes[4] + 2) & 0xff          // counter 低位 +2(跳变即可,不必精确)
      bytes[8] = (bytes[8] & ~0x08) | 0x01      // 清 autoDetect(LE 低字节),置 DIRECT
      bytes.push(0xaa)                           // 变长(真机 56→105)
      store[CONNECTION_ITEM] = { type: 'REG_BINARY', data: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('') }
      save(store)
      log('normalize', CONNECTION_ITEM, store[CONNECTION_ITEM])
    }
  }
}
