import { expect, it } from 'vitest'
import { validProductionVerifyFallbackUrl, validProductionVerifyUrl, validVerifyUrl } from '../../sidecar/mac/vless-settings.mjs'
import { createSshSocksConnector, CONTROL_CODES } from '../../sidecar/mac/connectors.mjs'
import { createVlessConnector } from '../../sidecar/mac/vless-connector.mjs'

it('生产验证地址只允许公共 HTTPS 标准端口', () => {
  expect(validProductionVerifyUrl('https://probe.example.com/ip')).toBe(true)
  for (const value of [
    'http://probe.example.com/ip', 'https://probe.example.com:8443/ip', 'https://127.0.0.1/ip',
    'https://10.0.0.1/ip', 'https://100.64.0.1/ip', 'https://169.254.169.254/latest',
    'https://[::1]/ip', 'https://[::ffff:127.0.0.1]/ip', 'https://localhost/ip', 'https://localhost./ip',
    'https://localhost../ip', 'https://foo.localhost/ip', 'https://foo.localdomain./ip', 'https://foo.localdomain.../ip',
    'https://foo.local./ip', 'https://foo.internal./ip', 'https://foo.internal../ip',
    'https://metadata.google.internal/ip'
  ]) expect(validProductionVerifyUrl(value)).toBe(false)
})

it('本地回环只通过显式测试开关，备用地址仍须不同主机', () => {
  const local = 'http://127.0.0.1:24444/toolbox-exit-ip'
  expect(validProductionVerifyUrl(local)).toBe(false)
  expect(validProductionVerifyUrl(local, { allowLocalVerifyUrls: true })).toBe(true)
  expect(validProductionVerifyFallbackUrl('https://probe.example.com/ip', 'https://backup.example.com/ip')).toBe(true)
  expect(validProductionVerifyFallbackUrl('https://probe.example.com/ip', 'https://probe.example.com/other')).toBe(false)
})

it('保护域名在尾点和多尾点形式下仍被拒绝', () => {
  for (const value of [
    'https://deepseek.com./ip', 'https://x.deepseek.com./ip', 'https://deepseek.com.../ip',
    'https://deepseek.cn./ip', 'https://deepseek.ai.../ip'
  ]) {
    expect(validVerifyUrl(value)).toBe(false)
    expect(validProductionVerifyUrl(value)).toBe(false)
  }
})

it('运行期连接器也拒绝未经过包校验的本机复验地址', () => {
  const sshSpec = {
    kind: 'ssh-socks' as const, node: { host: 'node.example.com', port: 22, sshUser: 'toolbox' },
    keyPath: '/tmp/key', knownHostsPath: '/tmp/known_hosts', localPort: 18080,
    verifyUrl: 'http://127.0.0.1:24444/ip'
  }
  expect(() => createSshSocksConnector(sshSpec)).toThrow(CONTROL_CODES.upstreamUnreachable)
  expect(() => createVlessConnector({
    kind: 'vless-reality', node: { host: 'node.example.com', port: 443 }, credentialPath: '/tmp/missing', localPort: 18080,
    verifyUrl: 'http://127.0.0.1:24444/ip'
  })).toThrow(CONTROL_CODES.upstreamUnreachable)
})
