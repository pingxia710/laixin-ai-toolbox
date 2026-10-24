import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export type ProxyAuthorizationFailure = { code: string; message: string }
const denied = (): ProxyAuthorizationFailure => ({
  code: 'TUNNEL_PROXY_AUTH_REQUIRED',
  message: '需要管理员授权才能设置系统代理。请重新点击连接，在 macOS 弹窗中允许；没有管理员密码请联系电脑管理员。'
})
const failed = (): ProxyAuthorizationFailure => ({
  code: 'TUNNEL_PROXY_HELPER_FAILED', message: '系统代理助手未就绪，已停止重连。请重新点击连接；仍失败请联系来信客服。'
})

// GUI process only. A durable, proxy-only helper retains recovery authority;
// neither Electron nor its user-writable JavaScript is launched as root.
export function createMacProxyAuthorization(sidecarDir: string, run = execute) {
  const helper = join(sidecarDir, 'bin', 'proxy-helper')
  let pending: Promise<ProxyAuthorizationFailure | undefined> | undefined
  const ready = async () => {
    try {
      const { stdout } = await run(helper, ['status'], {
        encoding: 'utf8', timeout: 3_000, maxBuffer: 16_384
      })
      const result: unknown = JSON.parse(String(stdout))
      return result !== null && typeof result === 'object' && 'ok' in result && result.ok === true &&
        'version' in result && result.version === 3
    } catch { return false }
  }
  const authorize = async (): Promise<ProxyAuthorizationFailure | undefined> => {
    if (await ready()) return undefined
    const uid = process.getuid?.()
    if (uid === undefined || uid < 501) return failed()
    try {
      await run('/usr/bin/osascript', ['-e', [
        'on run argv',
        'do shell script ((quoted form of item 1 of argv) & " install " & (quoted form of item 2 of argv)) with administrator privileges with prompt "来信AI工具箱需要设置系统代理，并在断开或异常退出时恢复原设置。"',
        'end run'
      ].join('\n'), helper, String(uid)], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16_384 })
    } catch (error) {
      const detail = error as { stderr?: unknown }
      return /\(-128\)|\(-60005\)/.test(String(detail.stderr ?? '')) ? denied() : failed()
    }
    // launchd bootstrap returns before the socket is listening.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await ready()) return undefined
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return failed()
  }
  return () => {
    pending ??= authorize().finally(() => { pending = undefined })
    return pending
  }
}
