import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { appendSettingEntry, loadLedger } from '../../sidecar/win/ledger.mjs'
import { recoverLedger, restoreLedger } from '../../sidecar/win/restore.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { makeTempDir, readFakeOps, removeTempDir } from './helpers'

describe('旧 Windows 会话的回环豁免账目恢复', () => {
  let dataDir: string
  let storePath: string
  const ref = { service: 'WinINET', item: 'ProxyOverride' }
  const original = { type: 'REG_SZ', data: ';localhost.*;;localhost.*;<local>;localhost;127.*' }
  const written = { type: 'REG_SZ', data: 'localhost.*;<local>;localhost;127.*' }

  beforeEach(() => {
    dataDir = makeTempDir('laixin-old-proxy-override-')
    storePath = join(dataDir, 'wininet.json')
  })
  afterEach(() => removeTempDir(dataDir))

  function setup(current: typeof original) {
    const adapter = createAdapter({ FAKE_WININET_STORE: storePath })
    appendSettingEntry(dataDir, { ...ref, originalValue: original, writtenValue: written, sessionToken: 'legacy', time: 1 })
    adapter.write(ref, current)
    return adapter
  }

  function quarantine() {
    const path = join(dataDir, 'ledger.json')
    const entries = JSON.parse(readFileSync(path, 'utf8')) as unknown[]
    entries.push({ corrupted: true })
    writeFileSync(path, JSON.stringify(entries))
    expect(() => loadLedger(dataDir)).toThrow()
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
  }

  it.each(['normal', 'normalized', 'write-failed', 'external', 'rebound', 'changed-on-write'] as const)(
    '损坏账本隔离恢复也区分原始格式与保留现值（%s）', (mode) => {
      const external = { type: 'REG_SZ', data: '127.*;LOCALHOST;localhost.*;<LOCAL>' }
      const adapter = setup(mode === 'external' ? external : written)
      quarantine()
      const guarded = { ...adapter,
        write: (item: typeof ref, value: typeof original) => {
          if (mode === 'write-failed') throw new Error('injected write failure')
          if (mode === 'changed-on-write') {
            adapter.write(item, { type: 'REG_SZ', data: 'other.example' })
            throw new Error('injected concurrent change')
          }
          adapter.write(item, mode === 'normalized' ? written : value)
        },
        broadcastSettingsChanged: () => {
          if (mode === 'rebound') adapter.write(ref, written)
        }
      }
      const result = recoverLedger(dataDir, guarded)!
      expect(readdirSync(dataDir).some((name) => name.startsWith('ledger.json.bad-'))).toBe(true)
      if (mode === 'changed-on-write') {
        expect(result.failed).toHaveLength(1)
        expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
        return
      }
      expect(result.failed).toEqual([])
      expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(false)
      if (mode === 'normal' || mode === 'rebound') {
        expect(adapter.read(ref)).toEqual(original)
        expect(result.recovered).toHaveLength(1)
        expect(result.keptModified).toHaveLength(0)
      } else {
        expect(adapter.read(ref)).toEqual(mode === 'external' ? external : written)
        expect(result.recovered).toHaveLength(0)
        expect(result.keptModified).toHaveLength(1)
        expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting')?.status).toBe('preserved')
      }
    })

  it('未结账的旧会话仍显示本产品写入值时，恢复账本中的原始格式', () => {
    const adapter = setup(written)
    const result = restoreLedger(dataDir, adapter)
    expect(adapter.read(ref)).toEqual(original)
    expect(result.failed).toEqual([])
    expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting')?.status).toBe('restored')
  })

  it('第三方随后写入不同但等价的格式时保留第三方现值', () => {
    const later = { type: 'REG_SZ', data: '127.*;LOCALHOST;localhost.*;<LOCAL>' }
    const adapter = setup(later)
    const writeCount = readFakeOps(storePath).filter((op) => op.op === 'write').length
    const result = restoreLedger(dataDir, adapter)
    expect(adapter.read(ref)).toEqual(later)
    expect(readFakeOps(storePath).filter((op) => op.op === 'write')).toHaveLength(writeCount)
    expect(result.restored).toHaveLength(0)
    expect(result.keptModified).toHaveLength(1)
    expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting')?.status).toBe('preserved')
  })

  it('写回后系统仍规范化为等价值时如实保留现值，不将等价格式当作逐字恢复', () => {
    const adapter = setup(written)
    const normalizing = { ...adapter, write: (item: typeof ref) => adapter.write(item, written) }
    const result = restoreLedger(dataDir, normalizing)
    expect(adapter.read(ref)).toEqual(written)
    expect(result.failed).toEqual([])
    expect(result.restored).toHaveLength(0)
    expect(result.keptModified).toHaveLength(1)
    expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting')).toMatchObject({
      status: 'preserved', note: expect.stringContaining('原始格式')
    })
  })

  it('写回失败但现值仍与原值语义等价时记录保留，不阻断普通网络', () => {
    const adapter = setup(written)
    const failing = { ...adapter, write: () => { throw new Error('injected write failure') } }
    const result = restoreLedger(dataDir, failing)
    expect(adapter.read(ref)).toEqual(written)
    expect(result.failed).toEqual([])
    expect(result.restored).toHaveLength(0)
    expect(result.keptModified).toHaveLength(1)
    expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting')).toMatchObject({
      status: 'preserved', note: expect.stringContaining('原始格式')
    })
  })

  it('广播触发系统把格式改回本产品写入值时，再写回原始格式', () => {
    const adapter = setup(written)
    const rebound = { ...adapter, broadcastSettingsChanged: () => adapter.write(ref, written) }
    const result = restoreLedger(dataDir, rebound)
    expect(result.failed).toEqual([])
    expect(adapter.read(ref)).toEqual(original)
  })

  it('写回失败且当前值已不再与原值等价时保留失败责任', () => {
    const adapter = setup(written)
    const changed = { type: 'REG_SZ', data: 'other.example' }
    const failing = { ...adapter, write: () => { adapter.write(ref, changed); throw new Error('injected write failure') } }
    const result = restoreLedger(dataDir, failing)
    expect(adapter.read(ref)).toEqual(changed)
    expect(result.failed).toHaveLength(1)
    expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting')?.status).toBe('restore-failed')
  })

  it('广播后重写返回失败但实际已写成原值时，以读回的原值结算', () => {
    const adapter = setup(written)
    let writes = 0
    const rebound = {
      ...adapter,
      broadcastSettingsChanged: () => adapter.write(ref, written),
      write: (item: typeof ref, value: typeof original) => {
        adapter.write(item, value)
        if (++writes === 2) throw new Error('injected error after write')
      }
    }
    const result = restoreLedger(dataDir, rebound)
    expect(adapter.read(ref)).toEqual(original)
    expect(result.failed).toEqual([])
    expect(result.restored).toHaveLength(1)
    expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting')?.status).toBe('restored')
  })

  it('广播后重写的结果不再等价时，不能同时报恢复成功', () => {
    const adapter = setup(written)
    const changed = { type: 'REG_SZ', data: 'other.example' }
    let writes = 0
    const rebound = {
      ...adapter,
      broadcastSettingsChanged: () => adapter.write(ref, written),
      write: (item: typeof ref, value: typeof original) => adapter.write(item, ++writes === 2 ? changed : value)
    }
    const result = restoreLedger(dataDir, rebound)
    expect(adapter.read(ref)).toEqual(changed)
    expect(result.restored).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting')?.status).toBe('restore-failed')
  })
})
