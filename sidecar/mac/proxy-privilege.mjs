import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const executable = fileURLToPath(new URL('./bin/proxy-helper', import.meta.url))
const messages = {
  TUNNEL_PROXY_AUTH_REQUIRED: '需要管理员授权才能设置系统代理，请点击连接并在 macOS 弹窗中允许。',
  TUNNEL_PROXY_HELPER_FAILED: '系统代理助手未完成操作，已停止重连。请重新点击连接；仍失败请联系客服。'
}
const reasons = {
  TIMEOUT: '等待超时', CONNECTION_REFUSED: '监听器不可用', NOT_INSTALLED: '尚未安装',
  CONNECT_FAILED: '连接失败', IO_FAILED: '通信失败', DISCONNECTED: '助手异常退出',
  INVALID_RESPONSE: '响应格式异常', PROCESS_FAILED: '请求进程异常',
  REQUEST_EXCEPTION: '请求处理异常', SYSTEM_CONFIGURATION: '系统配置操作失败',
  PREFERENCES_CREATE_FAILED: '无法打开系统网络配置', PREFERENCES_LOCK_FAILED: '系统网络配置正忙',
  CURRENT_SET_NOT_FOUND: '无法读取当前网络位置', CURRENT_SET_SERVICES_FAILED: '无法读取当前网络位置中的服务',
  SERVICE_NOT_FOUND: '当前网络位置中找不到正在使用的网络服务',
  SERVICE_AMBIGUOUS: '当前网络位置中存在多个同名网络服务，请在系统网络设置中保留正在使用的一项后重试',
  PROXIES_PROTOCOL_ADD_FAILED: '无法创建代理协议', PROXIES_PROTOCOL_COPY_FAILED: '无法读取代理协议',
  PROXIES_SET_FAILED: '无法写入代理字典', PREFERENCES_COMMIT_FAILED: '无法保存系统代理',
  PREFERENCES_APPLY_FAILED: '无法应用系统代理'
}
function failure(code, reason, systemCode) {
  const detail = Object.hasOwn(reasons, reason ?? '') ? `（${reasons[reason]}${Number.isInteger(systemCode) && systemCode !== 0 ? `，错误 ${systemCode}` : ''}）` : ''
  return Object.assign(new Error(messages[code] + detail), { code, reason })
}

export function proxyRequest(request) {
  let result
  try {
    result = JSON.parse(execFileSync(executable, ['request'], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 12_000, maxBuffer: 16_384
    }))
  } catch (error) {
    throw failure('TUNNEL_PROXY_HELPER_FAILED', error?.code === 'ETIMEDOUT' ? 'TIMEOUT' :
      error instanceof SyntaxError ? 'INVALID_RESPONSE' : 'PROCESS_FAILED')
  }
  if (result?.ok === true && result.version === 3) return
  const code = Object.hasOwn(messages, result?.code ?? '') ? result.code : 'TUNNEL_PROXY_HELPER_FAILED'
  throw failure(code, result?.reason, result?.systemCode)
}
