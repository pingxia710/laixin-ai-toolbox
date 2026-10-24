import { describe, expect, it, vi } from 'vitest'
import { createApiDestinationGate } from '../../sidecar/shared/api-destination-gate.mjs'

describe('API 后台通道目标限制', () => {
  it('交接保留 API 在途连接，关闭普通目标；正常使用恢复后解除限制', () => {
    const gate = createApiDestinationGate()
    const apiClose = vi.fn(), otherClose = vi.fn()
    const api = gate.track(apiClose), other = gate.track(otherClose)
    expect(api.consume(Buffer.from('CONNECT api.deepseek.com:443 HTTP/1.1\r\n\r\n'))).toBe(true)
    expect(other.consume(Buffer.from('CONNECT example.com:443 HTTP/1.1\r\n\r\n'))).toBe(true)
    gate.restrict(['api.deepseek.com:443'])
    expect(apiClose).not.toHaveBeenCalled()
    expect(otherClose).toHaveBeenCalledTimes(1)
    expect(api.consume(Buffer.alloc(65536))).toBe(true)
    expect(gate.track(vi.fn()).consume(Buffer.from('CONNECT api.deepseek.com.evil.test:443 HTTP/1.1\r\n'))).toBe(false)
    expect(gate.track(vi.fn()).consume(Buffer.from('CONNECT api.deepseek.com:8443 HTTP/1.1\r\n'))).toBe(false)
    expect(gate.track(vi.fn()).consume(Buffer.from('GET http://api.deepseek.com/ HTTP/1.1\r\n'))).toBe(false)
    gate.restrict(undefined)
    expect(gate.track(vi.fn()).consume(Buffer.from('CONNECT example.com:443 HTTP/1.1\r\n'))).toBe(true)
  })

  it.each(['api.deepseek.com', 'example.com'])('SOCKS5 分块握手只允许精确目标：%s', host => {
    const gate = createApiDestinationGate()
    gate.restrict(['api.deepseek.com:443'])
    const connection = gate.track(vi.fn())
    const command = Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([1, 187])])
    for (const byte of command.subarray(0, -1)) expect(connection.consume(Buffer.from([byte]))).toBe(true)
    expect(connection.consume(command.subarray(-1))).toBe(host === 'api.deepseek.com')
  })

  it('限制变化和连接销账不遗留目标授权', () => {
    const gate = createApiDestinationGate()
    const close = vi.fn(), connection = gate.track(close)
    connection.consume(Buffer.from('CONNECT api.deepseek.com:443 HTTP/1.1\r\n'))
    connection.forget()
    gate.restrict([])
    expect(close).not.toHaveBeenCalled()
    expect(gate.track(vi.fn()).consume(Buffer.from('CONNECT api.deepseek.com:443 HTTP/1.1\r\n'))).toBe(false)
  })
})
