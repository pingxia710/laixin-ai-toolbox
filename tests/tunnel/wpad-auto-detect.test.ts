// 公司网络的「自动检测设置」(WPAD，场景清单 #21)：它开着且网络上真有 WPAD 服务器时，
// 浏览器拿到的 PAC **优先于**我们写的手工代理——客户点了连接、我们也确实写进去了，
// 他的流量却没走我们这条路。连接期间临时关掉它，退出时按账本还回去。
//
// ⚠️ 两条独立的限定：①这份二进制结构没有微软文档，位置是从第三方实现反推的；
// ②没有在 Windows 真机上验证过。所以失败形态只允许有一种：**没做成**（原样不动，回落到今天的行为）。
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  autoDetectBitsEqual, autoDetectEnabled, autoDetectManagedItem, blobToHex, hexToBlob, readConnectionSettings, withAutoDetectDisabled
} from '../../sidecar/win/connection-settings.mjs'
import { describeManagedSettings } from '../../app/main/diagnostics/report-collect'
import { appendSettingEntry, loadLedger } from '../../sidecar/win/ledger.mjs'
import { restoreLedger } from '../../sidecar/win/restore.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { makeTempDir, removeTempDir } from './helpers'

/** version=0x46, counter=1, flags=?，后面跟一段「不归我们管」的尾巴。 */
function blobWith(flags: number, counter = 1, tail = 'DEADBEEF'): string {
  const head = new Uint8Array(12)
  const view = new DataView(head.buffer)
  view.setUint32(0, 0x46, true)
  view.setUint32(4, counter, true)
  view.setUint32(8, flags, true)
  return blobToHex(head) + tail
}

describe('WPAD 自动检测设置', () => {
  it('认得出格式、读得出标志位', () => {
    expect(readConnectionSettings(hexToBlob(blobWith(0b1011))!)).toEqual({ version: 0x46, counter: 1, flags: 0b1011 })
    expect(autoDetectEnabled(hexToBlob(blobWith(0b1011))!)).toBe(true)  // 含 8
    expect(autoDetectEnabled(hexToBlob(blobWith(0b0011))!)).toBe(false) // 不含 8
  })

  it('关掉自动检测:只动那一位,counter+1,其余字节一个不动', () => {
    const before = hexToBlob(blobWith(0b1011, 7, 'CAFEBABE'))!
    const after = withAutoDetectDisabled(before)!
    expect(readConnectionSettings(after)).toEqual({ version: 0x46, counter: 8, flags: 0b0011 })
    // 尾巴（代理地址、豁免列表、PAC 地址都住在那儿）原样
    expect(blobToHex(after).slice(24)).toBe('CAFEBABE')
    // 同一份 blob 里别人的位没被顺手清掉
    expect(readConnectionSettings(after)!.flags & 0b0011).toBe(0b0011)
  })

  it('本来就关着:无事可做,⛔ 无谓地写一次、记一笔账', () => {
    expect(withAutoDetectDisabled(hexToBlob(blobWith(0b0011))!)).toBeUndefined()
  })

  it('认不得格式一律不动——最坏是没生效,⛔ 是写坏客户的连接设置', () => {
    expect(readConnectionSettings(hexToBlob('4600')!)).toBeUndefined()          // 太短
    expect(readConnectionSettings(hexToBlob(blobWith(0b1011).replace(/^46000000/, '00000000'))!)).toBeUndefined() // 版本字节离谱
    expect(readConnectionSettings(hexToBlob(blobWith(0x1234))!)).toBeUndefined() // flags 高位有货，没把握
    expect(autoDetectEnabled(hexToBlob('4600')!)).toBeUndefined()               // ⛔ 当成 false
    expect(withAutoDetectDisabled(hexToBlob('4600')!)).toBeUndefined()
    expect(hexToBlob('46000')).toBeUndefined()                                  // 奇数长度
    expect(hexToBlob('46ZZ0000')).toBeUndefined()                               // 非十六进制
  })

  it('受管项:开着才纳入,整份 blob 进账本（还原走账本既有语义,⛔ 特殊路）', () => {
    const ref = { service: 'WinINET', item: 'DefaultConnectionSettings' }
    const on = { type: 'REG_BINARY', data: blobWith(0b1011) }
    const item = autoDetectManagedItem(on, ref)!
    expect(item.ref).toEqual(ref)
    expect(item.value.type).toBe('REG_BINARY')
    // 写入值是整份 blob —— 账本比的是整份，所以「当前值 ≠ 我们写进去的值 ⇒ 保留现值」自然成立
    expect(readConnectionSettings(hexToBlob(item.value.data)!)!.flags).toBe(0b0011)
    // 关着 / 读不到 / 类型不对 / 格式认不得 —— 一律不纳入
    expect(autoDetectManagedItem({ type: 'REG_BINARY', data: blobWith(0b0011) }, ref)).toBeUndefined()
    expect(autoDetectManagedItem(null, ref)).toBeUndefined()
    expect(autoDetectManagedItem({ type: 'REG_SZ', data: 'x' }, ref)).toBeUndefined()
    expect(autoDetectManagedItem({ type: 'REG_BINARY', data: 'ZZ' }, ref)).toBeUndefined()
  })

  it('适配器：自动检测开着时它出现在受管项里，关着时不出现', () => {
    const dir = makeTempDir('wpad-')
    const store = join(dir, 'registry.json')
    const write = (flags: number) => writeFileSync(store, JSON.stringify({
      ProxyEnable: { type: 'REG_DWORD', data: '0' },
      DefaultConnectionSettings: { type: 'REG_BINARY', data: blobWith(flags) }
    }))

    write(0b1011)
    const names = () => createAdapter({ FAKE_WININET_STORE: store })
      .managedItems({ host: '127.0.0.1', port: 18080 }).map((entry) => entry.ref.item)
    expect(names()).toContain('DefaultConnectionSettings')

    // 正向证据：同一个适配器、同一份 store，只把那一位关掉，它就不该再出现
    write(0b0011)
    expect(names()).not.toContain('DefaultConnectionSettings')
    // 而四个老项一直都在（⛔ 只断言「没出现」——整个清单空了也长这样）
    expect(names()).toContain('ProxyServer')
    removeTempDir(dir)
  })

  it('诊断里客服看得见我们动过这一项——⛔ 对客户说，但 ⛔ 不留痕', () => {
    const applied = [{ kind: 'setting', service: 'WinINET', item: 'DefaultConnectionSettings', status: 'applied' }]
    expect(describeManagedSettings(applied)[0]).toContain('自动检测设置')
    expect(describeManagedSettings(applied)[0]).toContain('尚未还原')
    expect(describeManagedSettings([{ ...applied[0], status: 'restored' }])[0]).toContain('并已还原')
    // 正向证据：别的项不该被顺手描述；账本里没有这一项时一句都不加
    expect(describeManagedSettings([{ kind: 'setting', service: 'WinINET', item: 'ProxyServer', status: 'applied' }])).toEqual([])
    expect(describeManagedSettings([])).toEqual([])
    expect(describeManagedSettings(undefined)).toEqual([])
    // ⛔ 带原始值（那是客户机器上的设置内容）
    const withValue = [{ ...applied[0], originalValue: { type: 'REG_BINARY', data: 'CAFEBABE' } }]
    expect(describeManagedSettings(withValue)[0]).not.toContain('CAFEBABE')
  })

  it('适配器：受管项写进去之后读得回来，且确实关掉了那一位', () => {
    const dir = makeTempDir('wpad-')
    const store = join(dir, 'registry.json')
    writeFileSync(store, JSON.stringify({
      ProxyEnable: { type: 'REG_DWORD', data: '0' },
      DefaultConnectionSettings: { type: 'REG_BINARY', data: blobWith(0b1011) }
    }))
    const adapter = createAdapter({ FAKE_WININET_STORE: store })
    const ref = { service: 'WinINET', item: 'DefaultConnectionSettings' }
    const item = adapter.managedItems({ host: '127.0.0.1', port: 18080 })
      .find((entry) => entry.ref.item === 'DefaultConnectionSettings')!
    adapter.write(ref, item.value)
    const back = adapter.read(ref) as { type: string; data: string }
    expect(autoDetectEnabled(hexToBlob(back.data)!)).toBe(false)
    // 写回去的确实是整份（尾巴还在），⛔ 只写了个头
    expect(back.data.length).toBe(blobWith(0b1011).length)
    expect(JSON.parse(readFileSync(store, 'utf8')).DefaultConnectionSettings.type).toBe('REG_BINARY')
    removeTempDir(dir)
  })
})

// W2-1(真机 2026-09-14):Windows 会对代理相关值做连带规范化——counter 跳变、DIRECT 位置位、
// 整份 56→105 字节重写。整份字节比对把我们自己的写入判成「外部改动」→ 退出时客户的
// 「自动检测设置」停在关。还原判据只看我们动过的那一位:flags 的 autoDetect 位。
describe('W2-1 还原判据:只认我们动过的那一位', () => {
  it('autoDetectBitsEqual:语义位相等,其余字节(counter/DIRECT/长度)随 Windows 规范化去', () => {
    const original = blobWith(0b1000, 5, 'DEADBEEF')          // 客户原值:autoDetect 开
    const written = blobWith(0b0000, 6, 'DEADBEEF')           // 我们写入:关
    const normalized = blobWith(0b0001, 0x0a, 'DEADBEEF' + 'AA'.repeat(49)) // Windows 规范化后:DIRECT 置位、counter 跳变、变长
    expect(autoDetectBitsEqual(normalized, written)).toBe(true)   // 我们的位还在 → 还是我的
    expect(autoDetectBitsEqual(normalized, original)).toBe(false) // 位不是原值的 → 不是「已是原值」
    expect(autoDetectBitsEqual(original, original)).toBe(true)
    // 认不得格式(undefined)由调用方回落字节比:这里钉死返回值本身
    expect(autoDetectBitsEqual('1234', written)).toBeUndefined()
  })

  it('真机 W2-1 场:规范化后的现值 → 按账本写回原值、状态 restored(原来是 preserved 停在关)', async () => {
    const dir = makeTempDir('wpad-w21-')
    const store = join(dir, 'registry.json')
    const original = { type: 'REG_BINARY', data: blobWith(0b1000, 5, 'DEADBEEF') }
    const written = { type: 'REG_BINARY', data: blobWith(0b0000, 6, 'DEADBEEF') }
    const normalized = { type: 'REG_BINARY', data: blobWith(0b0001, 0x0a, 'DEADBEEF' + 'AA'.repeat(49)) }
    writeFileSync(store, JSON.stringify({ DefaultConnectionSettings: normalized }))
    appendSettingEntry(dir, { service: 'WinINET', item: 'DefaultConnectionSettings', originalValue: original, writtenValue: written, sessionToken: 'w21', time: 1 })
    const result = restoreLedger(dir, createAdapter({ FAKE_WININET_STORE: store }))
    expect(result.restored).toHaveLength(1)
    expect(result.keptModified).toHaveLength(0)
    const entry = loadLedger(dir).find((candidate) => (candidate as { item?: string }).item === 'DefaultConnectionSettings')!
    expect((entry as { status: string }).status).toBe('restored')
    // 客户的「自动检测设置」回来了:注册表里是原值,位=开
    const back = JSON.parse(readFileSync(store, 'utf8')).DefaultConnectionSettings as { data: string }
    expect(back.data).toBe(original.data)
    expect(autoDetectEnabled(hexToBlob(back.data)!)).toBe(true)
    removeTempDir(dir)
  })

  it('回落检查:还原写回后系统在收尾广播里又把它规范化回我们的写入值 → 再写回一次原值(真机 W2-1 第二幕)', () => {
    const dir = makeTempDir('wpad-fall-')
    const store = join(dir, 'registry.json')
    const original = { type: 'REG_BINARY', data: blobWith(0b1000, 5, 'DEADBEEF') }
    const written = { type: 'REG_BINARY', data: blobWith(0b0000, 6, 'DEADBEEF') }
    // 广播即规范化(autoDetect 位被清、DIRECT 置位、counter 跳变、变长)——真机上就是这个形状
    writeFileSync(store, JSON.stringify({ DefaultConnectionSettings: written }))
    appendSettingEntry(dir, { service: 'WinINET', item: 'DefaultConnectionSettings', originalValue: original, writtenValue: written, sessionToken: 'fall', time: 1 })
    restoreLedger(dir, createAdapter({ FAKE_WININET_STORE: store, FAKE_WININET_NORMALIZE_BLOB: '1' }))
    const entry = loadLedger(dir).find((candidate) => (candidate as { item?: string }).item === 'DefaultConnectionSettings')!
    expect((entry as { status: string }).status).toBe('restored')
    expect((entry as { note?: string }).note).toContain('已重写原值')
    // 最终注册表:位必须真的回到开(回落检查补的那一笔),⛔ 停在系统规范化出来的关
    const back = JSON.parse(readFileSync(store, 'utf8')).DefaultConnectionSettings as { data: string }
    expect(autoDetectEnabled(hexToBlob(back.data)!)).toBe(true)
    removeTempDir(dir)
  })

  it('客户中途自己改回开:退出时保留他的现值,⛔ 拿原值覆盖他', async () => {
    const dir = makeTempDir('wpad-w21b-')
    const store = join(dir, 'registry.json')
    const original = { type: 'REG_BINARY', data: blobWith(0b1000, 5, 'DEADBEEF') }
    const written = { type: 'REG_BINARY', data: blobWith(0b0000, 6, 'DEADBEEF') }
    const reEnabled = { type: 'REG_BINARY', data: blobWith(0b1001, 0x0c, 'DEADBEEF') } // 客户手动开:位回来了,counter 也动了
    writeFileSync(store, JSON.stringify({ DefaultConnectionSettings: reEnabled }))
    appendSettingEntry(dir, { service: 'WinINET', item: 'DefaultConnectionSettings', originalValue: original, writtenValue: written, sessionToken: 'w21b', time: 1 })
    restoreLedger(dir, createAdapter({ FAKE_WININET_STORE: store }))
    const entry = loadLedger(dir).find((candidate) => (candidate as { item?: string }).item === 'DefaultConnectionSettings')!
    // 判定「已是原值」(位=开)或「保留现值」都行—— Registry 里必须是客户的开,⛔ 被写成别的
    expect(['restored', 'preserved']).toContain((entry as { status: string }).status)
    const back = JSON.parse(readFileSync(store, 'utf8')).DefaultConnectionSettings as { data: string }
    expect(autoDetectEnabled(hexToBlob(back.data)!)).toBe(true)
    removeTempDir(dir)
  })
})
