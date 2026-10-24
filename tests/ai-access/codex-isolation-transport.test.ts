import { describe, expect, it, vi } from 'vitest'
import { CodexIsolationTransport, type CodexIsolationSession } from '../../app/main/ai-access/codex-isolation-transport'
import { ApplicationIsolationHttpConnectTransport } from '../../app/main/ai-access/application-isolation-transport'

function session(resolved = 'PROXY 127.0.0.1:18080') {
  const value: CodexIsolationSession = {
    closeAllConnections: vi.fn(async () => undefined),
    setProxy: vi.fn(async () => undefined),
    resolveProxy: vi.fn(async () => resolved),
    fetch: vi.fn(async () => new Response('ok'))
  }
  return value
}

describe('N-56 Codex 独立入口传输', () => {
  it('公开能力型 HTTP/CONNECT 传输不要求 OS 进程身份，也不读取 NO_PROXY', async () => {
    const privateSession = session()
    const transport = new ApplicationIsolationHttpConnectTransport({ create: () => privateSession })

    await transport.activate('http://127.0.0.1:18080', 'https://api.example.test/responses')

    expect(privateSession.resolveProxy).toHaveBeenCalledWith('https://api.example.test/responses')
    expect(privateSession.fetch).not.toHaveBeenCalled()
  })

  it('只在私有会话里固定已复验的本机入口，不使用或写入系统代理模式', async () => {
    const privateSession = session()
    const transport = new CodexIsolationTransport({ create: () => privateSession })

    await transport.activate('http://127.0.0.1:18080', 'https://api.example.test/responses')

    expect(privateSession.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:18080', proxyBypassRules: '<-loopback>' })
    expect(privateSession.setProxy).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'system' }))
    expect(privateSession.resolveProxy).toHaveBeenCalledWith('https://api.example.test/responses')
  })

  it.each(['DIRECT', 'PROXY 127.0.0.1:18080; DIRECT', 'PROXY 127.0.0.1:18080; PROXY 127.0.0.1:19090'])('入口解析为 %s 时 fail closed，并把私有会话清成 direct', async (resolved) => {
    const privateSession = session(resolved)
    const transport = new CodexIsolationTransport({ create: () => privateSession })

    await expect(transport.activate('http://127.0.0.1:18080', 'https://api.example.test/responses')).rejects.toThrow('APPLICATION_ISOLATION_ENTRY_UNVERIFIED')
    expect(privateSession.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
    await expect(transport.fetch('https://api.example.test/responses')).rejects.toThrow('APPLICATION_ISOLATION_ENTRY_UNAVAILABLE')
  })

  it('入口解析本身报错也清空私有会话，不能留下半配置代理', async () => {
    const privateSession = session()
    privateSession.resolveProxy = vi.fn(async () => { throw new Error('fixture resolve failure') })
    const transport = new CodexIsolationTransport({ create: () => privateSession })

    await expect(transport.activate('http://127.0.0.1:18080', 'https://api.example.test/responses')).rejects.toThrow('fixture resolve failure')
    expect(privateSession.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
    await expect(transport.fetch('https://api.example.test/responses')).rejects.toThrow('APPLICATION_ISOLATION_ENTRY_UNAVAILABLE')
  })

  it('只有成功绑定后的 Codex 网关请求走私有会话；关闭时清空该会话而非改系统网络', async () => {
    const privateSession = session()
    const transport = new CodexIsolationTransport({ create: () => privateSession })
    await transport.activate('http://127.0.0.1:18080', 'https://api.example.test/responses')

    await expect(transport.fetch('https://api.example.test/responses', { method: 'POST' })).resolves.toBeInstanceOf(Response)
    expect(privateSession.fetch).toHaveBeenCalledOnce()
    await transport.deactivate()
    expect(privateSession.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
  })

  it.each(['http://10.0.0.8:18080', 'http://user:pass@127.0.0.1:18080', 'socks5://127.0.0.1:18080'])('拒绝非受控本机 HTTP 入口 %s', async (entry) => {
    const privateSession = session()
    const transport = new CodexIsolationTransport({ create: () => privateSession })

    await expect(transport.activate(entry, 'https://api.example.test/responses')).rejects.toThrow('APPLICATION_ISOLATION_ENTRY_INVALID')
    expect(privateSession.setProxy).not.toHaveBeenCalled()
  })

  it('接受 IPv6 回环入口，但不把它扩展为任何非回环代理', async () => {
    const privateSession = session('PROXY [::1]:18080')
    const transport = new CodexIsolationTransport({ create: () => privateSession })

    await transport.activate('http://[::1]:18080', 'https://api.example.test/responses')

    expect(privateSession.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'http://[::1]:18080', proxyBypassRules: '<-loopback>' })
  })

  it('Codex 与 Claude 各使用独立非持久 session；撤销 Claude 不会停掉 Codex transport', async () => {
    const codexSession = session()
    const claudeSession = session('PROXY 127.0.0.1:18081')
    const codex = new ApplicationIsolationHttpConnectTransport({ create: () => codexSession })
    const claude = new ApplicationIsolationHttpConnectTransport({ create: () => claudeSession })

    await codex.activate('http://127.0.0.1:18080', 'https://api.example.test/responses')
    await claude.activate('http://127.0.0.1:18081', 'https://api.example.test/messages')
    await claude.deactivate()
    await expect(codex.fetch('https://api.example.test/responses')).resolves.toBeInstanceOf(Response)
    await expect(claude.fetch('https://api.example.test/messages')).rejects.toThrow('APPLICATION_ISOLATION_ENTRY_UNAVAILABLE')

    expect(codexSession).not.toBe(claudeSession)
    expect(codexSession.fetch).toHaveBeenCalledOnce()
    expect(codexSession.setProxy).not.toHaveBeenLastCalledWith({ mode: 'direct' })
    expect(claudeSession.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
  })
})
