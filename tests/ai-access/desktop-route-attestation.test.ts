import { describe, expect, it, vi } from 'vitest'
import { createDesktopRouteAttestor, macSocketOwnerPids, type DesktopRouteCommandExecutor } from '../../app/main/ai-access/desktop-route-attestation'

const localPort = 43_100
const remotePort = 58_521
const socket = { localAddress: '127.0.0.1', localPort, remoteAddress: '127.0.0.1', remotePort }
const desktopExecutable = '/Applications/Codex.app/Contents/Frameworks/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer)'
const chatGptExecutable = '/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper (Renderer).app/Contents/MacOS/ChatGPT Helper (Renderer)'

function macExecutor(overrides: Partial<Record<'lsof' | 'ps' | 'verify' | 'identity', { exitCode: number; output: string }>> = {}): DesktopRouteCommandExecutor {
  return {
    run: vi.fn(async (command: string, args: readonly string[]) => {
      if (command === '/usr/sbin/lsof') return overrides.lsof ?? {
        exitCode: 0,
        output: `p777\ncCodex Helper (Renderer)\nn127.0.0.1:${String(remotePort)}->127.0.0.1:${String(localPort)}\np888\ncnode\nn127.0.0.1:${String(localPort)}->127.0.0.1:${String(remotePort)}\n`
      }
      if (command === '/bin/ps') return overrides.ps ?? { exitCode: 0, output: `${desktopExecutable}\n` }
      if (command === '/usr/bin/codesign' && args[0] === '--verify') return overrides.verify ?? { exitCode: 0, output: '' }
      if (command === '/usr/bin/codesign') return overrides.identity ?? { exitCode: 0, output: 'Identifier=com.openai.codex\nTeamIdentifier=2DC432GLL2\n' }
      throw new Error('unexpected command')
    })
  }
}

describe('Codex Desktop 同 socket 验收', () => {
  it('macOS 只有官方签名桌面进程拥有当前 gateway client socket 才通过', async () => {
    const executor = macExecutor()
    const attestor = createDesktopRouteAttestor({ platform: 'darwin', executor, resolveRealPath: async () => '/Applications/Codex.app' })

    const result = await attestor.observe(socket)

    expect(result).toMatchObject({ status: 'verified', reason: 'verified_socket_bound_desktop', at: expect.any(String) })
    expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['/usr/sbin/lsof', ['-nP', '-Fpn', '-a', '-iTCP', '-sTCP:ESTABLISHED']],
      ['/bin/ps', ['-p', '777', '-o', 'comm=']],
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '/Applications/Codex.app']],
      ['/usr/bin/codesign', ['-d', '--verbose=4', '/Applications/Codex.app']]
    ])
  })

  it('当前安装可能叫 ChatGPT.app；只要同一进程所在 app 的签名标识和团队都匹配，仍可验证', async () => {
    const executor = macExecutor({ ps: { exitCode: 0, output: `${chatGptExecutable}\n` } })
    const attestor = createDesktopRouteAttestor({ platform: 'darwin', executor, resolveRealPath: async () => '/Applications/ChatGPT.app' })

    await expect(attestor.observe(socket)).resolves.toMatchObject({ status: 'verified', reason: 'verified_socket_bound_desktop' })
    expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toContainEqual(['/usr/bin/codesign', ['--verify', '--deep', '--strict', '/Applications/ChatGPT.app']])
  })

  it('CLI、伪装 User-Agent、时间或人工标记都不会替代 socket 所有者与官方签名', async () => {
    const secret = 'sk-desktop-attestation-fixture-must-not-escape'
    const executor = macExecutor({ ps: { exitCode: 0, output: '/usr/local/bin/codex\n' } })
    const attestor = createDesktopRouteAttestor({ platform: 'darwin', executor, resolveRealPath: async () => '/Applications/Codex.app' })

    const result = await attestor.observe({ ...socket, userAgent: `Codex Desktop ${secret}`, manualClaim: secret, observedAt: new Date().toISOString() } as typeof socket)

    expect(result).toEqual({ status: 'unverified', at: null, reason: 'socket_owner_not_codex_desktop' })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect((executor.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('签名不匹配或 socket 所有者不唯一一律不通过', async () => {
    const forged = createDesktopRouteAttestor({
      platform: 'darwin', executor: macExecutor({ identity: { exitCode: 0, output: 'Identifier=com.openai.codex\nTeamIdentifier=FORGED\n' } }),
      resolveRealPath: async () => '/Applications/Codex.app'
    })
    await expect(forged.observe(socket)).resolves.toEqual({ status: 'unverified', at: null, reason: 'desktop_signature_unverified' })

    const ambiguous = createDesktopRouteAttestor({
      platform: 'darwin', executor: macExecutor({ lsof: {
        exitCode: 0,
        output: `p777\nn127.0.0.1:${String(remotePort)}->127.0.0.1:${String(localPort)}\np778\nn127.0.0.1:${String(remotePort)}->127.0.0.1:${String(localPort)}\n`
      } }),
      resolveRealPath: async () => '/Applications/Codex.app'
    })
    await expect(ambiguous.observe(socket)).resolves.toEqual({ status: 'unverified', at: null, reason: 'socket_owner_ambiguous' })
  })

  it('Windows/Linux 与错误 socket 元数据 fail closed，不能发起任何本机探测命令', async () => {
    const executor = macExecutor()
    const windows = createDesktopRouteAttestor({ platform: 'win32', executor })
    const linux = createDesktopRouteAttestor({ platform: 'linux', executor })
    const mac = createDesktopRouteAttestor({ platform: 'darwin', executor, resolveRealPath: async () => '/Applications/Codex.app' })

    await expect(windows.observe(socket)).resolves.toEqual({ status: 'unverified', at: null, reason: 'platform_unsupported' })
    await expect(linux.observe(socket)).resolves.toEqual({ status: 'unverified', at: null, reason: 'platform_unsupported' })
    await expect(mac.observe({ ...socket, remoteAddress: '127.0.0.2' })).resolves.toEqual({ status: 'unverified', at: null, reason: 'socket_metadata_unavailable' })
    expect(executor.run).not.toHaveBeenCalled()
  })

  it('只认精确反向 TCP 元组，永远不会把 gateway 自己的 server-side socket 当成客户端', () => {
    expect(macSocketOwnerPids(`p1\nn127.0.0.1:${String(localPort)}->127.0.0.1:${String(remotePort)}\np2\nn127.0.0.1:${String(remotePort)}->127.0.0.1:${String(localPort)}\n`, localPort, remotePort)).toEqual([2])
    expect(macSocketOwnerPids(`p3\nn127.0.0.1:${String(remotePort + 1)}->127.0.0.1:${String(localPort)}\n`, localPort, remotePort)).toEqual([])
  })
})
