import { describe, expect, it } from 'vitest'
import { baseUrlFromCodexToml, residualAddressNote, residualLoopbackAddress } from '../../app/main/ai-access/residual-address'

// 别的工具留下的死地址：接口地址指着 127.0.0.1 的某个端口，而那个端口上没有程序在监听。
// 认出它、把话说全（点名端口、说清来历）；备份与覆盖在接管流程里本来就有，⛔ 在这里改接管行为。
describe('别的工具留下的死地址', () => {
  it('本机回环地址带端口才算数；不是本机、不是 URL、空值都不算', () => {
    expect(residualLoopbackAddress('http://127.0.0.1:57547/claude/deepseek')).toMatchObject({ host: '127.0.0.1', port: 57547 })
    expect(residualLoopbackAddress('http://localhost:9000/v1')).toMatchObject({ host: 'localhost', port: 9000 })
    expect(residualLoopbackAddress('https://127.0.0.1')).toMatchObject({ port: 443 })
    expect(residualLoopbackAddress('http://proxy.corp.example:8080')).toBeNull()
    expect(residualLoopbackAddress('http://10.0.0.2:8080')).toBeNull()
    expect(residualLoopbackAddress('not a url')).toBeNull()
    expect(residualLoopbackAddress('')).toBeNull()
    expect(residualLoopbackAddress(undefined)).toBeNull()
  })

  it('地址里内嵌的凭据一律去掉：报给客户的只有协议 + 主机 + 端口 + 路径', () => {
    // 只带用户名的写法（令牌当用户名）。
    const withToken = residualLoopbackAddress('http://sk-ant-0123456789abcdef@127.0.0.1:8080/v1')!
    expect(withToken.url).toBe('http://127.0.0.1:8080/v1')
    const tokenNote = residualAddressNote('Codex', withToken)
    expect(tokenNote).toContain('127.0.0.1:8080')
    expect(tokenNote).not.toContain('sk-ant-0123456789abcdef')
    // 用户名 + 密码的写法。
    const withUserPass = residualLoopbackAddress('http://user:sk-secret-0123456789@127.0.0.1:7890')!
    expect(withUserPass.url).toBe('http://127.0.0.1:7890/')
    const userPassNote = residualAddressNote('Claude Code', withUserPass)
    expect(userPassNote).not.toContain('sk-secret-0123456789')
    expect(userPassNote).not.toContain('user:')
    // 密码里带 URL 特殊字符（@ : /）也照样剥干净。
    const encoded = residualLoopbackAddress('http://alice:p%40ss%2Fword@127.0.0.1:7891/v1')!
    expect(encoded.url).toBe('http://127.0.0.1:7891/v1')
    expect(encoded.url).not.toContain('alice')
    expect(encoded.url).not.toContain('p%40ss')
  })

  it('报给客户的话点名端口、写上原地址、说清是别的工具留下的', () => {
    const note = residualAddressNote('Claude Code', residualLoopbackAddress('http://127.0.0.1:57547/claude/deepseek')!)
    expect(note).toContain('57547')
    expect(note).toContain('http://127.0.0.1:57547/claude/deepseek')
    expect(note).toContain('别的工具')
    expect(note).toContain('死配置')
    expect(note).toContain('CC Switch')
    expect(note).toContain('备份')
  })

  it('Codex 的 TOML：顶层 model_provider 指到哪张表就读那张表的 base_url', () => {
    expect(baseUrlFromCodexToml([
      'model = "gpt-5"',
      'model_provider = "ccswitch"',
      '',
      '[model_providers.ccswitch]',
      'base_url = "http://127.0.0.1:57548/v1"',
      ''
    ].join('\n'))).toBe('http://127.0.0.1:57548/v1')
    // 表名带引号的写法一样认。
    expect(baseUrlFromCodexToml([
      'model_provider = "cc-switch"',
      '[model_providers."cc-switch"]',
      'base_url = "http://localhost:9001"',
      ''
    ].join('\n'))).toBe('http://localhost:9001')
    // 没指到第三方表（比如有多张表但没选）就别乱报。
    expect(baseUrlFromCodexToml('[model_providers.other]\nbase_url = "http://127.0.0.1:1"\n')).toBeUndefined()
    expect(baseUrlFromCodexToml('model = "gpt-5"\n')).toBeUndefined()
    expect(baseUrlFromCodexToml('')).toBeUndefined()
  })
})
