import { afterEach, expect, it, vi } from 'vitest'
import { composeManagedAdapters } from '../../sidecar/win/managed-adapter.mjs'
import { wininetValuesEqual } from '../../sidecar/win/wininet-values.mjs'
import { createTerminalEnvironmentAdapter } from '../../sidecar/win/terminal-environment.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { appendSettingEntry, loadLedger, markEntry, pendingSettingEntries } from '../../sidecar/win/ledger.mjs'
import { restoreLedger, unrestoredEntries } from '../../sidecar/win/restore.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const directories: string[] = []
afterEach(() => { directories.splice(0).forEach(removeTempDir); vi.unstubAllEnvs() })
const ref = { service: 'WinINET', item: 'ProxyOverride' }
const value = (data: string) => ({ type: 'REG_SZ', data })

it('真实组合适配器传递字段语义和修复能力，终端文件不自动接管', () => {
  const root = makeTempDir('win-intent-composite-'); directories.push(root)
  const network = createAdapter({ FAKE_WININET_STORE: `${root}/registry.json` })
  const adapter = composeManagedAdapters(network, createTerminalEnvironmentAdapter({ enabled: false }))
  expect(adapter.valuesEqual?.(value('<local>;localhost;127.*'), value('127.*;LOCALHOST;<local>;'), ref)).toBe(true)
  expect(adapter.valuesEqual?.(value('http://EXAMPLE/'), value('http://example/'), { ...ref, item: 'AutoConfigURL' })).toBe(false)
  expect(adapter.reapplyOnChange?.(ref)).toBe(true)
  expect(adapter.reapplyOnChange?.({ service: 'TerminalEnvironment', item: 'profile' })).toBe(false)
})

it('旧版 kept-modified 恢复为保留终态，保留原记录且下次连接不再被挡住', () => {
  const root = makeTempDir('win-intent-recovery-'); directories.push(root)
  const adapter = createAdapter({ FAKE_WININET_STORE: `${root}/registry.json` })
  const entry = appendSettingEntry(root, { ...ref, originalValue: null, writtenValue: value('<local>;localhost;127.*'), sessionToken: 'local-test', time: 1 })
  markEntry(root, entry.id, { status: 'kept-modified' })
  adapter.write(ref, value('corp.example'))
  const result = restoreLedger(root, adapter)
  expect(result.keptModified).toHaveLength(1)
  expect(result.keptModified[0].status).toBe('preserved')
  expect(pendingSettingEntries(root)).toEqual([])
  expect(unrestoredEntries(root)).toEqual([])
  expect(adapter.read(ref)).toEqual(value('corp.example'))
  expect(loadLedger(root)).toHaveLength(1)
  expect(restoreLedger(root, adapter)).toEqual({ restored: [], keptModified: [], failed: [] })
})

it('豁免语义比较不把新增或删掉的规则当等价，也不影响代理地址比较', () => {
  expect(wininetValuesEqual(value('<local>;127.*'), value('<local>;127.*;*.example.com'), ref)).toBe(false)
  expect(wininetValuesEqual(value('localhost'), value('LOCALHOST;'), { ...ref, item: 'ProxyServer' })).toBe(false)
})
