import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendSettingEntry, ledgerFailure, loadLedger } from '../../sidecar/win/ledger.mjs'
import { recoverLedger, restoreLedger } from '../../sidecar/shared/restore.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const daemon = fileURLToPath(new URL('../../sidecar/win/tunnel-daemon.mjs', import.meta.url))
const fakeAdapter = fileURLToPath(new URL('./fixtures/fake-wininet-adapter.mjs', import.meta.url))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

function restore(dataDir: string, proxyServer: string | null, env: NodeJS.ProcessEnv = {}) {
  const storePath = join(dataDir, 'wininet.json')
  writeFileSync(storePath, JSON.stringify({
    ProxyEnable: { type: 'REG_DWORD', data: '1' },
    ...(proxyServer === null ? {} : { ProxyServer: { type: 'REG_SZ', data: proxyServer } })
  }))
  const run = spawnSync(process.execPath, [daemon, 'restore', '--data-dir', dataDir, '--adapter', fakeAdapter], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, FAKE_WININET_STORE: storePath, ...env }
  })
  return { run, store: JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, { data: string }> }
}

it('N-44: 账本为空时第三方后来占用同一个 18080 端口，离线恢复不应擅自关闭', () => {
  const dataDir = makeTempDir('n44-third-party-same-port-')
  roots.push(dataDir)
  const { run, store } = restore(dataDir, '127.0.0.1:18080')
  expect(store.ProxyEnable.data).toBe('1')
  expect(run.status).toBe(65)
  expect(JSON.parse(run.stdout)).toMatchObject({ ownershipUnknown: true })
})

it('N-44: 只剩已结算终端账目且 WinINET 账目丢失时，死口仍不能假报恢复', () => {
  const dataDir = makeTempDir('n44-terminal-only-dead-proxy-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'TerminalEnvironment', item: 'HTTP_PROXY', originalValue: null,
    writtenValue: { value: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  const ledgerPath = join(dataDir, 'ledger.json')
  const entries = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Array<Record<string, unknown>>
  entries[0].status = 'restored'
  writeFileSync(ledgerPath, JSON.stringify(entries))
  const { run, store } = restore(dataDir, '127.0.0.1:18080')
  expect(run.status).toBe(65)
  expect(store.ProxyEnable.data).toBe('1')
  expect(JSON.parse(run.stdout)).toMatchObject({ ownershipUnknown: true })
})

it('N-44: 空账本随机死口连续两次恢复都保留归属核实责任', () => {
  const dataDir = makeTempDir('n44-random-port-repeat-')
  roots.push(dataDir)
  const storePath = join(dataDir, 'wininet.json')
  writeFileSync(storePath, JSON.stringify({ ProxyEnable: { type: 'REG_DWORD', data: '1' },
    ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:51234' } }))
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ state: 'connected', bridgePort: 51234 }))
  const run = () => spawnSync(process.execPath, [daemon, 'restore', '--data-dir', dataDir, '--adapter', fakeAdapter], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, FAKE_WININET_STORE: storePath }
  })
  const first = run()
  expect(first.status).toBe(65)
  expect(JSON.parse(first.stdout)).toMatchObject({ ownershipUnknown: true, suspectProxyPort: 51234 })
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).bridgePort).toBeUndefined()
  const second = run()
  expect(second.status).toBe(65)
  expect(JSON.parse(second.stdout)).toMatchObject({ ownershipUnknown: true, suspectProxyPort: 51234 })
  expect(JSON.parse(readFileSync(storePath, 'utf8'))).toMatchObject({
    ProxyEnable: { data: '1' }, ProxyServer: { data: '127.0.0.1:51234' }
  })
})

it('N-44: 空账本随机端口由第三方活进程接管时仍允许完成且不改设置', () => {
  const dataDir = makeTempDir('n44-random-third-party-live-')
  roots.push(dataDir)
  const { run, store } = restore(dataDir, '127.0.0.1:51234', { FAKE_WININET_PORT_OWNER: 'other' })
  expect(run.status).toBe(0)
  expect(store).toMatchObject({ ProxyEnable: { data: '1' }, ProxyServer: { data: '127.0.0.1:51234' } })
})

it.each(['http=127.0.0.1:51234;https=127.0.0.1:51234', '[::1]:51234',
  'https = 127.0.0.1:51234', 'https= 127.0.0.1:51234'])(
  'N-44: 空账本代理地址 %s 不能因格式漏判而声称恢复成功', (proxyServer) => {
    const dataDir = makeTempDir('n44-loopback-format-')
    roots.push(dataDir)
    const { run, store } = restore(dataDir, proxyServer)
    expect(run.status).toBe(65)
    expect(JSON.parse(run.stdout)).toMatchObject({ ownershipUnknown: true, suspectProxyPort: 51234 })
    expect(store).toMatchObject({ ProxyEnable: { data: '1' }, ProxyServer: { data: proxyServer } })
  }
)

it('N-44: 分协议代理第一口有活监听、第二口已死时仍不误报恢复', () => {
  const dataDir = makeTempDir('n44-split-proxy-')
  roots.push(dataDir)
  const { run, store } = restore(dataDir, 'http=127.0.0.1:18080;https=127.0.0.1:51234',
    { FAKE_WININET_PORT_OWNER_SEQUENCE: 'other,none' })
  expect(run.status).toBe(65)
  expect(JSON.parse(run.stdout)).toMatchObject({ ownershipUnknown: true, suspectProxyPort: 51234 })
  expect(store.ProxyEnable.data).toBe('1')
})

it('N-44: 第三方活监听恰在来信候选口，离线恢复保留它且不误报恢复失败', () => {
  const dataDir = makeTempDir('n44-third-party-live-port-')
  roots.push(dataDir)
  const { run, store } = restore(dataDir, '127.0.0.1:18080', { FAKE_WININET_PORT_OWNER: 'other' })
  expect(run.status).toBe(0)
  expect(store.ProxyEnable.data).toBe('1')
  expect(JSON.parse(run.stdout).ownershipUnknown).toBeUndefined()
})

it.each([
  ['ProxyEnable 读数失败', { FAKE_WININET_READ_FAILURE: 'ProxyEnable', FAKE_WININET_READ_FAILURE_COUNT: '1', FAKE_WININET_PORT_OWNER: 'other' }],
  ['ProxyServer 读数失败', { FAKE_WININET_READ_FAILURE: 'ProxyServer', FAKE_WININET_READ_FAILURE_COUNT: '1', FAKE_WININET_PORT_OWNER: 'other' }],
  ['端口归属查询抛错', { FAKE_WININET_PORT_OWNER_SEQUENCE: 'throw,other' }]
])('N-44: 空账本 %s 后重查成功，不修改第三方代理', (_name, env) => {
  const dataDir = makeTempDir('n44-proxy-inspection-failed-')
  roots.push(dataDir)
  const { run, store } = restore(dataDir, '127.0.0.1:18080', env)
  expect(run.status).toBe(0)
  expect(store.ProxyEnable.data).toBe('1')
  expect(JSON.parse(run.stdout).inspectionFailed).toBeUndefined()
  const ops = readFileSync(join(dataDir, 'wininet.json.ops.jsonl'), 'utf8')
  expect(ops).toMatch(/read-failed|"key":"throw"/)
  expect(ops).not.toContain('"op":"write"')
})

it('N-44: 账本确认来信写入的失效代理，离线 restore 恢复普通网络', () => {
  const dataDir = makeTempDir('n44-owned-dead-proxy-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const { run, store } = restore(dataDir, '127.0.0.1:18080')
  expect(run.status).toBe(0)
  expect(store.ProxyEnable.data).toBe('0')
  expect(store.ProxyServer).toBeUndefined()
})

it('N-44: 第三方换了 ProxyServer 且活监听，离线 restore 保留其开关', () => {
  const dataDir = makeTempDir('n44-third-party-handoff-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const { run, store } = restore(dataDir, '127.0.0.1:7890', { FAKE_WININET_PORT_OWNER: 'other' })
  expect(run.status).toBe(0)
  expect(store.ProxyServer.data).toBe('127.0.0.1:7890')
  expect(store.ProxyEnable.data).toBe('1')
  const entries = loadLedger(dataDir)
  expect(entries.find((entry) => entry.kind === 'setting' && entry.item === 'ProxyEnable')).toMatchObject({ status: 'preserved' })
})

it('N-44: 争抢止损只记录第三方现值时结清旧托管账目，不回写来信代理', () => {
  const dataDir = makeTempDir('n44-contest-accounting-')
  roots.push(dataDir)
  const external = { type: 'REG_SZ', data: 'other.proxy:7892' }
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: external,
    writtenValue: external, sessionToken: 'n44', time: 3 })
  const storePath = join(dataDir, 'wininet.json')
  writeFileSync(storePath, JSON.stringify({ ProxyEnable: { type: 'REG_DWORD', data: '1' }, ProxyServer: external }))
  const result = restoreLedger(dataDir, createAdapter({ FAKE_WININET_STORE: storePath }))
  expect(result.failed).toHaveLength(0)
  expect(result.keptModified).toHaveLength(3)
  expect(loadLedger(dataDir).filter((entry) => entry.kind === 'setting').map((entry) => entry.status))
    .toEqual(['preserved', 'preserved', 'preserved'])
  expect(readFileSync(storePath, 'utf8')).toContain('other.proxy:7892')
  expect(readFileSync(`${storePath}.ops.jsonl`, 'utf8')).not.toContain('"op":"write"')
})

it('N-44: 第三方活进程接管相同 18080 时保留整组代理设置', () => {
  const dataDir = makeTempDir('n44-same-port-live-handoff-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const { run, store } = restore(dataDir, '127.0.0.1:18080', { FAKE_WININET_PORT_OWNER: 'other' })
  expect(run.status).toBe(0)
  expect(store.ProxyEnable.data).toBe('1')
  expect(store.ProxyServer.data).toBe('127.0.0.1:18080')
  expect(loadLedger(dataDir).filter((entry) => entry.kind === 'setting')).toEqual(expect.arrayContaining([
    expect.objectContaining({ item: 'ProxyServer', status: 'preserved' }),
    expect.objectContaining({ item: 'ProxyEnable', status: 'preserved' })
  ]))
})

it('N-44: 另一份来信监听时不动同会话代理', () => {
  const dataDir = makeTempDir('n44-peer-owner-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const { run, store } = restore(dataDir, '127.0.0.1:18080', { FAKE_WININET_PORT_OWNER: 'laixin' })
  expect(run.status).toBe(65)
  expect(store.ProxyEnable.data).toBe('1')
  expect(store.ProxyServer.data).toBe('127.0.0.1:18080')
})

it.each(['unknown', 'ambiguous'])('N-44: 端口归属暂时 %s 时保留恢复责任，查询恢复后自动补还', (owner) => {
  const dataDir = makeTempDir('n44-owner-probe-retry-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const { run, store } = restore(dataDir, '127.0.0.1:18080', { FAKE_WININET_PORT_OWNER_SEQUENCE: `${owner},none` })
  expect(run.status).toBe(0)
  expect(store.ProxyEnable.data).toBe('0')
  expect(store.ProxyServer).toBeUndefined()
  expect(loadLedger(dataDir).filter((entry) => entry.kind === 'setting'))
    .toEqual(expect.arrayContaining([expect.objectContaining({ item: 'ProxyEnable', status: 'restored' })]))
})

it('N-44: 坏账本缺启用开关的写入值时不能假结算并清恢复标记', () => {
  const dataDir = makeTempDir('n44-missing-written-enable-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const ledgerPath = join(dataDir, 'ledger.json')
  const entries = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Array<Record<string, unknown>>
  delete entries[1].writtenValue
  writeFileSync(ledgerPath, JSON.stringify(entries))
  const { run, store } = restore(dataDir, '127.0.0.1:18080')
  expect(run.status).toBe(65)
  expect(store.ProxyEnable.data).toBe('1')
  expect(store.ProxyServer.data).toBe('127.0.0.1:18080')
  expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
})

it('N-44: 仅第三方 bypass 改动不阻断自有死代理还原', () => {
  const dataDir = makeTempDir('n44-bypass-only-handoff-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyOverride', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '<local>;localhost;127.*' }, sessionToken: 'n44', time: 3 })
  const storePath = join(dataDir, 'wininet.json')
  writeFileSync(storePath, JSON.stringify({ ProxyEnable: { type: 'REG_DWORD', data: '1' },
    ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:18080' },
    ProxyOverride: { type: 'REG_SZ', data: '<local>;localhost;127.*;corporate.internal' } }))
  const run = spawnSync(process.execPath, [daemon, 'restore', '--data-dir', dataDir, '--adapter', fakeAdapter], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, FAKE_WININET_STORE: storePath }
  })
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, { data: string }>
  expect(run.status).toBe(0)
  expect(store.ProxyEnable.data).toBe('0')
  expect(store.ProxyServer).toBeUndefined()
  expect(store.ProxyOverride.data).toContain('corporate.internal')
  expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting' && entry.item === 'ProxyOverride'))
    .toMatchObject({ status: 'preserved' })
})

it('N-44: 当前守护自己的监听尚未关闭时仍可按账本还原', () => {
  const dataDir = makeTempDir('n44-own-listener-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const { run, store } = restore(dataDir, '127.0.0.1:18080', { FAKE_WININET_PORT_OWNER: 'self' })
  expect(run.status).toBe(0)
  expect(store.ProxyEnable.data).toBe('0')
  expect(store.ProxyServer).toBeUndefined()
})

it('N-44: 当前 PID 即使进程名识别为 other，仍应按同一进程账本还原', () => {
  const dataDir = makeTempDir('n44-own-pid-other-name-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const { run, store } = restore(dataDir, '127.0.0.1:18080', { FAKE_WININET_PORT_OWNER: 'self-other' })
  expect(run.status).toBe(0)
  expect(store.ProxyEnable.data).toBe('0')
  expect(store.ProxyServer).toBeUndefined()
})

it('N-44: 第三方活监听接管 Server 后不恢复旧 PAC 覆盖其代理路径', () => {
  const dataDir = makeTempDir('n44-third-party-old-pac-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'AutoConfigURL',
    originalValue: { type: 'REG_SZ', data: 'http://old.example/proxy.pac' }, writtenValue: null,
    sessionToken: 'n44', time: 3 })
  const { run, store } = restore(dataDir, '127.0.0.1:7890', { FAKE_WININET_PORT_OWNER: 'other' })
  expect(run.status).toBe(0)
  expect(store.ProxyServer.data).toBe('127.0.0.1:7890')
  expect(store.ProxyEnable.data).toBe('1')
  expect(store.AutoConfigURL).toBeUndefined()
  expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting' && entry.item === 'AutoConfigURL'))
    .toMatchObject({ status: 'preserved' })
})

it.each([18080, 51234])('N-44: 无旧 state 且第三方只写新 PAC，Server 指 %s 死口时不误报已恢复', (port) => {
  const dataDir = makeTempDir('n44-new-pac-handoff-')
  roots.push(dataDir)
  const proxyServer = `127.0.0.1:${port}`
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: proxyServer }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'AutoConfigURL', originalValue: null,
    writtenValue: null, sessionToken: 'n44', time: 3 })
  const storePath = join(dataDir, 'wininet.json')
  writeFileSync(storePath, JSON.stringify({ ProxyEnable: { type: 'REG_DWORD', data: '1' },
    ProxyServer: { type: 'REG_SZ', data: proxyServer },
    AutoConfigURL: { type: 'REG_SZ', data: 'http://new.example/proxy.pac' } }))
  expect(existsSync(join(dataDir, 'state.json'))).toBe(false)
  const run = spawnSync(process.execPath, [daemon, 'restore', '--data-dir', dataDir, '--adapter', fakeAdapter], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, FAKE_WININET_STORE: storePath }
  })
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, { data: string }>
  expect(run.status).toBe(65)
  expect(store.ProxyServer.data).toBe(proxyServer)
  expect(store.ProxyEnable.data).toBe('1')
  expect(store.AutoConfigURL.data).toBe('http://new.example/proxy.pac')
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')))
    .toMatchObject({ state: 'error', code: 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN' })
})

it('N-44: 普通账本缺同会话 ProxyServer 时不能凭开关值猜归属', () => {
  const dataDir = makeTempDir('n44-missing-peer-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const { run, store } = restore(dataDir, '127.0.0.1:7890')
  expect(run.status).toBe(65)
  expect(store.ProxyEnable.data).toBe('1')
  expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting' && entry.item === 'ProxyEnable'))
    .toMatchObject({ status: 'kept-modified' })
})

it('N-44: 代理地址已先还原原值，开关仍留在来信值时继续完成还原', () => {
  const dataDir = makeTempDir('n44-server-already-original-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const { run, store } = restore(dataDir, null)
  expect(run.status).toBe(0)
  expect(store.ProxyEnable.data).toBe('0')
  expect(store.ProxyServer).toBeUndefined()
})

it('N-44: 账本有坏条目进入隔离恢复时，也保留第三方活监听接管的代理开关', () => {
  const dataDir = makeTempDir('n44-quarantined-handoff-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'AutoConfigURL',
    originalValue: { type: 'REG_SZ', data: 'http://old.example/proxy.pac' }, writtenValue: null,
    sessionToken: 'n44', time: 3 })
  const ledgerPath = join(dataDir, 'ledger.json')
  const entries = JSON.parse(readFileSync(ledgerPath, 'utf8')) as unknown[]
  entries.push({ corrupted: true })
  writeFileSync(ledgerPath, JSON.stringify(entries))
  const { run, store } = restore(dataDir, '127.0.0.1:7890', { FAKE_WININET_PORT_OWNER: 'other' })
  expect(run.status).toBe(0)
  expect(store.ProxyServer.data).toBe('127.0.0.1:7890')
  expect(store.ProxyEnable.data).toBe('1')
  expect(store.AutoConfigURL).toBeUndefined()
  expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting' && entry.item === 'ProxyEnable'))
    .toMatchObject({ status: 'preserved' })
})

it('N-44: 损坏账本中单项 bypass 外部改动应标记保留而非已恢复', () => {
  const dataDir = makeTempDir('n44-quarantined-bypass-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyOverride', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '<local>;localhost;127.*' }, sessionToken: 'n44', time: 1 })
  const ledgerPath = join(dataDir, 'ledger.json')
  const entries = JSON.parse(readFileSync(ledgerPath, 'utf8')) as unknown[]
  entries.push({ corrupted: true })
  writeFileSync(ledgerPath, JSON.stringify(entries))
  const storePath = join(dataDir, 'wininet.json')
  writeFileSync(storePath, JSON.stringify({ ProxyEnable: { type: 'REG_DWORD', data: '0' },
    ProxyOverride: { type: 'REG_SZ', data: '<local>;localhost;127.*;corporate.internal' } }))
  const run = spawnSync(process.execPath, [daemon, 'restore', '--data-dir', dataDir, '--adapter', fakeAdapter], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, FAKE_WININET_STORE: storePath }
  })
  expect(run.status).toBe(0)
  expect(loadLedger(dataDir).find((entry) => entry.kind === 'setting' && entry.item === 'ProxyOverride'))
    .toMatchObject({ status: 'preserved' })
})

it('N-44: 适配器不支持保留外部改动时损坏账本仍留恢复责任', () => {
  const dataDir = makeTempDir('n44-quarantined-no-preserve-')
  roots.push(dataDir)
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
    writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'n44', time: 1 })
  appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
    writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
  const ledgerPath = join(dataDir, 'ledger.json')
  const entries = JSON.parse(readFileSync(ledgerPath, 'utf8')) as unknown[]
  entries.push({ corrupted: true })
  writeFileSync(ledgerPath, JSON.stringify(entries))
  const storePath = join(dataDir, 'wininet.json')
  writeFileSync(storePath, JSON.stringify({ ProxyEnable: { type: 'REG_DWORD', data: '1' },
    ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:7890' } }))
  const adapter = { ...createAdapter({ FAKE_WININET_STORE: storePath }), preserveExternalChanges: () => false }
  expect(ledgerFailure(dataDir)).toBeDefined()
  expect(recoverLedger(dataDir, adapter)?.failed.length).toBeGreaterThan(0)
  expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
  expect(JSON.parse(readFileSync(storePath, 'utf8'))).toMatchObject({
    ProxyEnable: { data: '1' }, ProxyServer: { data: '127.0.0.1:7890' }
  })
})

it('N-44: 卸载与更新兜底必须先核账本归属，不再把任意 localhost 当作来信', () => {
  const uninstall = readFileSync(fileURLToPath(new URL('../../resources/uninstall-task-cleanup.ps1', import.meta.url)), 'utf8')
  const helper = readFileSync(fileURLToPath(new URL('../../resources/update-helper.cjs', import.meta.url)), 'utf8')
  expect(uninstall).toContain('LAIXIN_PROXY_LEDGER_OWNERSHIP')
  expect(helper).toContain('LAIXIN_PROXY_LEDGER_OWNERSHIP')
  expect(uninstall).toContain('ledger-recovery-required')
  expect(helper).toContain('ledger-recovery-required')
  expect(uninstall).toContain('TerminalEnvironment')
  expect(helper).toContain('TerminalEnvironment')
  expect(uninstall).toContain("LocalAddress -in @('127.0.0.1','0.0.0.0')")
  expect(helper).toContain("LocalAddress -in @('127.0.0.1','0.0.0.0')")
  expect(uninstall).toContain("LocalAddress -eq '::'")
  expect(helper).toContain("LocalAddress -eq '::'")
})
