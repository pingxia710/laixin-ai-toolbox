// Real Mac adapter contracts with all system commands, writes and locks replaced.
import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

export async function createAdapter() {
  const scenario = process.env.MAC_RESTORE_SCENARIO
  const record = (operation) => appendFileSync(process.env.MAC_RESTORE_OPS, `${JSON.stringify(operation)}\n`)
  let restored = false
  childProcess.execFileSync = (command, args) => {
    record({ command, args })
    if (command !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
    if (scenario === 'read-failed') throw new Error('SIMULATED_READ_FAILURE')
    if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes...\nWi-Fi\nEthernet\n*Disabled\n'
    if (!['Wi-Fi', 'Ethernet'].includes(args[1])) throw new Error('UNEXPECTED_SERVICE')
    if (!['-getwebproxy', '-getsecurewebproxy', '-getsocksfirewallproxy'].includes(args[0])) throw new Error('UNEXPECTED_READ')
    const enabled = !restored && scenario !== 'off' && (scenario === 'second-service-dead'
      ? args[1] === 'Ethernet' && args[0] === '-getsocksfirewallproxy'
      : args[1] === 'Wi-Fi' && args[0] === '-getsecurewebproxy')
    const host = scenario === 'ipv6' ? '::1' : scenario === 'remote' ? 'proxy.test.invalid' : '127.0.0.1'
    return `Enabled: ${enabled ? 'Yes' : 'No'}\nServer: ${host}\nPort: 51234\nAuthenticated Proxy Enabled: 0\n`
  }
  syncBuiltinESMExports()
  process.env.TOOLBOX_REAL_NETWORK_ADAPTER = '1'
  const { createAdapter: createNetworkAdapter } = await import('../../../sidecar/mac/adapter-networksetup.mjs')
  const { composeManagedAdapters } = await import('../../../sidecar/mac/managed-adapter.mjs')
  const network = createNetworkAdapter({ writeProxy(ref, value) {
    record({ write: ref, value })
    if (scenario !== 'restored-ledger' || ref.service !== 'Wi-Fi' || ref.item !== 'secure-web-proxy' || value.enabled !== false) {
      throw new Error('UNEXPECTED_WRITE')
    }
    restored = true
  } })
  return composeManagedAdapters(network, {}, () => ({ acquired: true, release: () => true }), (port) => {
    record({ identifyPort: port })
    return { kind: scenario === 'live' ? 'other' : scenario === 'owner-unreadable' ? 'unknown' : 'none' }
  })
}
