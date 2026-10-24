import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { REDACTED, credentialFindings, pickRedacted, redactText, redactValue, sensitiveKey } from '../../app/main/diagnostics/report-redact'

/** 拿**真实形状**的假凭据来试——形状取自 sidecar 两端的 vless-settings.mjs、account/client.ts、ledger.mjs。 */
export function fakeCredentials() {
  return {
    // VLESS：uuid / 43 位 base64url 公钥 / 2–16 位十六进制 shortId
    uuid: '3f4a1c2e-9b8d-4e7f-a1b2-c3d4e5f60718',
    publicKey: randomBytes(32).toString('base64url'),
    shortId: 'a1b2c3d4',
    // 来信账号令牌：43 位 base64url
    accessToken: randomBytes(32).toString('base64url'),
    // 守护会话令牌
    sessionToken: `sess-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    // 模型 Key
    apiKey: `sk-ant-api03-${randomBytes(24).toString('base64url')}`,
    deepseekKey: `sk-${randomBytes(16).toString('hex')}`,
    // 带账号密码的入口地址
    nodeUri: 'vless://3f4a1c2e-9b8d-4e7f-a1b2-c3d4e5f60718@node.example.com:443?pbk=abc',
    proxyUri: 'http://customer:Passw0rd-secret@proxy.example.com:8080',
    hostKeyFingerprint: randomBytes(32).toString('hex')
  }
}

it('真实形状的假凭据一个都扫不出来也带不出去', () => {
  const credentials = fakeCredentials()
  for (const [name, value] of Object.entries(credentials)) {
    if (name === 'shortId') continue // 2–16 位十六进制，形状与普通十六进制无法区分，靠字段名与白名单两层拦（见下条用例）
    expect(credentialFindings(value), `${name} 没被认出来`).not.toHaveLength(0)
    expect(redactText(value), `${name} 没被抹掉`).not.toContain(value)
  }
})

it('shortId 这种短值靠字段名拦住：字段名带 shortId/uuid/key/token 的值整枝砍掉', () => {
  const credentials = fakeCredentials()
  const cleaned = redactValue({ vless: { uuid: credentials.uuid, publicKey: credentials.publicKey, shortId: credentials.shortId, serverName: 'www.example.com' } })
  const text = JSON.stringify(cleaned)
  expect(text).not.toContain(credentials.shortId)
  expect(text).not.toContain(credentials.uuid)
  expect(text).not.toContain(credentials.publicKey)
  // 非凭据字段照常留着，⛔ 把整个对象抹成空壳
  expect(text).toContain('www.example.com')
  for (const key of ['uuid', 'publicKey', 'shortId', 'sessionToken', 'intentToken', 'accessToken', 'apiKey', 'password', 'originalValue', 'writtenValue', 'Cookie', 'Authorization']) {
    expect(sensitiveKey(key), `${key} 应当算敏感字段名`).toBe(true)
  }
})

it('嵌在日志行、错误信息与地址里的凭据同样抹掉', () => {
  const credentials = fakeCredentials()
  const lines = [
    `[tunnel-daemon] 换下一条入口重试：${credentials.nodeUri}`,
    `[tunnel-daemon] 复用本机代理 ${credentials.proxyUri} 失败`,
    `请求头 Authorization: Bearer ${credentials.accessToken} 被拒`,
    `会话 ${credentials.sessionToken} 写入账本`,
    `主机指纹 ${credentials.hostKeyFingerprint} 不匹配`,
    `模型 Key ${credentials.apiKey} 无效`
  ].join('\n')
  const cleaned = redactText(lines)
  for (const value of [credentials.nodeUri, credentials.proxyUri, credentials.accessToken, credentials.sessionToken, credentials.hostKeyFingerprint, credentials.apiKey]) {
    expect(cleaned).not.toContain(value)
  }
  expect(cleaned).toContain(REDACTED)
  expect(credentialFindings(cleaned)).toHaveLength(0)
})

it('客服要用的错误码与客户/设备编号留得住，⛔ 连它们一起抹了', () => {
  const text = ['AI_DIAG_TUNNEL_UNREACHABLE', 'TUNNEL_AUTHORIZATION_INVALID', 'PACKAGE_HOST_FINGERPRINT_MISMATCH',
    'acct_0123456789abcdef0123456789abcdef', 'device_fedcba9876543210fedcba9876543210', '0.5.0 · darwin/arm64'].join(' ')
  expect(redactText(text)).toBe(text)
  expect(credentialFindings(text)).toHaveLength(0)
})

it('白名单取值只放行点名的字段，敏感字段名即使在白名单里也不放行', () => {
  const credentials = fakeCredentials()
  const state = { state: 'connected', code: 'TUNNEL_CONNECTED', sessionToken: credentials.sessionToken,
    intentToken: credentials.accessToken, bridgePort: 17_890, exitIp: '203.0.113.7' }
  const picked = pickRedacted(state, ['state', 'code', 'bridgePort', 'exitIp', 'sessionToken'])
  expect(picked).toEqual({ state: 'connected', code: 'TUNNEL_CONNECTED', bridgePort: 17_890, exitIp: '203.0.113.7' })
  expect(JSON.stringify(picked)).not.toContain(credentials.sessionToken)
})

it('原型链上的键与超深/超长取值进不来', () => {
  const polluted = JSON.parse('{"a":1,"__proto__":{"leak":"x"},"constructor":{"leak":"y"}}') as Record<string, unknown>
  const cleaned = redactValue(polluted) as Record<string, unknown>
  expect(Object.hasOwn(cleaned, '__proto__')).toBe(false)
  expect(Object.hasOwn(cleaned, 'constructor')).toBe(false)
  expect(({} as Record<string, unknown>).leak).toBeUndefined()
  const longLine = redactValue('通道复验超时 '.repeat(1_000), { maxStringLength: 100 }) as string
  expect(longLine).toHaveLength(100 + '…[已截断]'.length)
  expect(longLine.endsWith('…[已截断]')).toBe(true)
  expect(redactValue({ a: { b: { c: 1 } } }, { maxDepth: 1 })).toEqual({ a: { b: '[已省略：层级过深]' } })
})
