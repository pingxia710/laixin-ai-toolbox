import { describe, expect, it } from 'vitest'
import type { LedgerEntry, SettingEntry } from '../../sidecar/mac/ledger.mjs'
import type { DaemonStateView } from '../../app/main/tunnel/status-service'
import { diagnosticExistingProxyFromLedger } from '../../app/main/tunnel/tunnel-service'
import { readActiveMacNetworkPath } from '../../app/main/tunnel/platform/mac-active-network'

const daemon: DaemonStateView = { state: 'connected', sessionToken: 'n54-session', bridgePort: 18080 }
const entry = (service: string, item: string, originalValue: unknown, writtenValue: unknown, time = 1): SettingEntry => ({
  id: `${service}-${item}-${String(time)}`, kind: 'setting', service, item, originalValue, writtenValue,
  sessionToken: 'n54-session', time, status: 'applied', note: ''
})

describe('N-54 接管前现有代理证据', () => {
  it('macOS 只从同代未结算的 secure proxy 恢复值重建固定代理', () => {
    const entries: LedgerEntry[] = [
      entry('Wi-Fi', 'secure-web-proxy', { enabled: true, host: 'proxy.fixture.invalid', port: 8443 },
        { enabled: true, host: '127.0.0.1', port: 18080 }),
      entry('Wi-Fi', 'auto-proxy', { enabled: false, url: '' }, { enabled: false, url: '' }),
      entry('Ethernet', 'secure-web-proxy', { enabled: false, host: '', port: 0 },
        { enabled: true, host: '127.0.0.1', port: 18080 }),
      entry('Ethernet', 'auto-proxy', { enabled: false, url: '' }, { enabled: false, url: '' })
    ]
    expect(diagnosticExistingProxyFromLedger(entries, daemon, 'Wi-Fi')).toBe('http://proxy.fixture.invalid:8443')
  })

  it('macOS 只采用当前活动服务，活动 Wi-Fi 关闭时不拿非活动 Ethernet 的代理', () => {
    const entries: LedgerEntry[] = [
      entry('Wi-Fi', 'secure-web-proxy', { enabled: false, host: '', port: 0 },
        { enabled: true, host: '127.0.0.1', port: 18080 }),
      entry('Wi-Fi', 'auto-proxy', { enabled: false, url: '' }, { enabled: false, url: '' }),
      entry('Ethernet', 'secure-web-proxy', { enabled: true, host: 'inactive-proxy.invalid', port: 8443 },
        { enabled: true, host: '127.0.0.1', port: 18080 }),
      entry('Ethernet', 'auto-proxy', { enabled: false, url: '' }, { enabled: false, url: '' })
    ]

    expect(diagnosticExistingProxyFromLedger(entries, daemon, 'Wi-Fi')).toBeUndefined()
    expect(diagnosticExistingProxyFromLedger(entries, daemon, 'Ethernet')).toBe('http://inactive-proxy.invalid:8443')
  })

  it('macOS 无法证明当前活动服务身份时保持不可用', () => {
    const entries: LedgerEntry[] = [
      entry('Wi-Fi', 'secure-web-proxy', { enabled: true, host: 'proxy.fixture.invalid', port: 8443 },
        { enabled: true, host: '127.0.0.1', port: 18080 }),
      entry('Wi-Fi', 'auto-proxy', { enabled: false, url: '' }, { enabled: false, url: '' })
    ]

    expect(diagnosticExistingProxyFromLedger(entries, daemon)).toBeUndefined()
  })

  it('Windows 要求原 ProxyEnable 已开且无 PAC/WPAD，再按 HTTPS 规则重建', () => {
    const entries: LedgerEntry[] = [
      entry('WinINET', 'ProxyServer', { type: 'REG_SZ', data: 'http=plain.invalid:8080;https=secure.fixture.invalid:8443' },
        { type: 'REG_SZ', data: '127.0.0.1:18080' }),
      entry('WinINET', 'ProxyEnable', { type: 'REG_DWORD', data: '1' }, { type: 'REG_DWORD', data: '1' }),
      entry('WinINET', 'AutoConfigURL', { type: 'REG_SZ', data: '' }, null)
    ]
    expect(diagnosticExistingProxyFromLedger(entries, daemon)).toBe('http://secure.fixture.invalid:8443')
  })

  it('PAC/WPAD、旧代、已结算或多个冲突候选都不猜测', () => {
    const mac = entry('Wi-Fi', 'secure-web-proxy', { enabled: true, host: 'a.fixture.invalid', port: 8443 },
      { enabled: true, host: '127.0.0.1', port: 18080 })
    const second = entry('Ethernet', 'secure-web-proxy', { enabled: true, host: 'b.fixture.invalid', port: 9443 },
      { enabled: true, host: '127.0.0.1', port: 18080 })
    expect(diagnosticExistingProxyFromLedger([mac, second], daemon, 'Wi-Fi')).toBeUndefined()
    expect(diagnosticExistingProxyFromLedger([mac, entry('Wi-Fi', 'auto-proxy', { enabled: true, url: 'https://pac.invalid/x' },
      { enabled: false, url: 'https://pac.invalid/x' })], daemon, 'Wi-Fi')).toBeUndefined()
    expect(diagnosticExistingProxyFromLedger([{ ...mac, status: 'restored' }], daemon, 'Wi-Fi')).toBeUndefined()
    expect(diagnosticExistingProxyFromLedger([{ ...mac, sessionToken: 'old-session' }], daemon, 'Wi-Fi')).toBeUndefined()
  })

  it('恢复证据在 PAC 项落账前中断时保持不可用，不把未知当成关闭', () => {
    const mac = entry('Wi-Fi', 'secure-web-proxy', { enabled: true, host: 'proxy.fixture.invalid', port: 8443 },
      { enabled: true, host: '127.0.0.1', port: 18080 })
    const win: LedgerEntry[] = [
      entry('WinINET', 'ProxyServer', { type: 'REG_SZ', data: 'proxy.fixture.invalid:8443' },
        { type: 'REG_SZ', data: '127.0.0.1:18080' }),
      entry('WinINET', 'ProxyEnable', { type: 'REG_DWORD', data: '1' }, { type: 'REG_DWORD', data: '1' })
    ]
    expect(diagnosticExistingProxyFromLedger([mac], daemon, 'Wi-Fi')).toBeUndefined()
    expect(diagnosticExistingProxyFromLedger(win, daemon)).toBeUndefined()
    const complete = [mac, entry('Wi-Fi', 'auto-proxy', { enabled: false, url: '' }, { enabled: false, url: '' })]
    const incompleteSecond = entry('Ethernet', 'secure-web-proxy', { enabled: true, host: 'other.fixture.invalid', port: 9443 },
      { enabled: true, host: '127.0.0.1', port: 18080 })
    expect(diagnosticExistingProxyFromLedger([...complete, incompleteSecond], daemon, 'Wi-Fi')).toBe('http://proxy.fixture.invalid:8443')
  })

  it('Windows 注册表证据类型或 PAC 原值非法时不根据字符串猜测', () => {
    const base: SettingEntry[] = [
      entry('WinINET', 'ProxyServer', { type: 'REG_SZ', data: 'proxy.fixture.invalid:8443' },
        { type: 'REG_SZ', data: '127.0.0.1:18080' }),
      entry('WinINET', 'ProxyEnable', { type: 'REG_DWORD', data: '1' }, { type: 'REG_DWORD', data: '1' }),
      entry('WinINET', 'AutoConfigURL', { broken: true }, null)
    ]
    expect(diagnosticExistingProxyFromLedger(base, daemon)).toBeUndefined()
    expect(diagnosticExistingProxyFromLedger(base.map((item) => item.item === 'AutoConfigURL'
      ? { ...item, originalValue: null } : item.item === 'ProxyEnable'
        ? { ...item, originalValue: { type: 'REG_SZ', data: '1' } } : item), daemon)).toBeUndefined()
  })
})

describe('N-54 macOS 活动网络服务证据', () => {
  it('按默认路由设备绑定唯一服务，不按服务列表顺序或网卡名称猜测', () => {
    const run = (file: string, args: readonly string[]) => {
      if (file === '/sbin/route' && args.join(' ') === '-n get default') return '   interface: en0\n'
      if (file === 'networksetup' && args[0] === '-listnetworkserviceorder') {
        return '(1) Ethernet\n(Hardware Port: Ethernet, Device: en1)\n' +
          '(2) Office Wireless\n(Hardware Port: Wi-Fi, Device: en0)\n'
      }
      throw new Error('unexpected command')
    }

    expect(readActiveMacNetworkPath(run)).toEqual({ device: 'en0', service: 'Office Wireless' })
  })

  it('默认路由身份缺失或同一设备映射冲突时 fail closed', () => {
    const noRoute = (file: string, args: readonly string[]) => file === '/sbin/route'
      ? 'route to: default\n'
      : args[0] === '-listnetworkserviceorder' ? '(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n' : ''
    const conflict = (file: string, args: readonly string[]) => file === '/sbin/route'
      ? '   interface: en0\n'
      : args[0] === '-listnetworkserviceorder'
        ? '(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n(2) Ethernet\n(Hardware Port: Ethernet, Device: en0)\n'
        : ''

    expect(readActiveMacNetworkPath(noRoute)).toBeUndefined()
    expect(readActiveMacNetworkPath(conflict)).toBeUndefined()
  })

  it('夹读期间默认路由变化时 fail closed', () => {
    const routes = ['   interface: en0\n', '   interface: en1\n']
    const run = (file: string, args: readonly string[]) => file === '/sbin/route'
      ? routes.shift() ?? '   interface: en1\n'
      : args[0] === '-listnetworkserviceorder'
        ? '(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n(2) Ethernet\n(Hardware Port: Ethernet, Device: en1)\n'
        : ''

    expect(readActiveMacNetworkPath(run)).toBeUndefined()
  })
})
