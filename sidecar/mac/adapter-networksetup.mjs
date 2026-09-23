// 真实 macOS 系统设置适配器(networksetup)。
// 加载闸(判据 7):本片全部自动测试在假适配器上做;真实适配器只在
// TOOLBOX_REAL_NETWORK_ADAPTER=1 显式放行时可加载——该环境变量只由
// app/main/tunnel/platform/mac.ts 在真实启动路径注入。闸被移除 = 测试报红。
import { execFileSync } from 'node:child_process'
import { ConnectorError, CONTROL_CODES } from './connectors.mjs'
import { isOurProxy } from './proxy-identity.mjs'

if (process.env.TOOLBOX_REAL_NETWORK_ADAPTER !== '1') {
  throw new Error('REAL_ADAPTER_GUARD:真实网络适配器未获放行(TOOLBOX_REAL_NETWORK_ADAPTER!=1)')
}

// PAC(自动代理配置)开关也是受管项(GPT-6 复核 2a19530 #3):macOS/Chromium 里 PAC 优先于手动代理,接管时只写三项手动代理
// 而不关 PAC,客户的浏览器照样走旧 PAC。所以接管 = 记下原 PAC(开关 + 地址)→ 关掉;被人重新打开就修回;退出按账本原样还回去。
const AUTO_PROXY_ITEM = 'auto-proxy'

const PROXY_ITEMS = Object.freeze([
  { item: 'web-proxy', read: '-getwebproxy', write: '-setwebproxy', state: '-setwebproxystate' },
  { item: 'secure-web-proxy', read: '-getsecurewebproxy', write: '-setsecurewebproxy', state: '-setsecurewebproxystate' },
  { item: 'socks-proxy', read: '-getsocksfirewallproxy', write: '-setsocksfirewallproxy', state: '-setsocksfirewallproxystate' }
])

export function createAdapter() {
  return {
    // 已有代理不再是拒绝理由(发布审查 R4 / 创始人 09-13 晚标准):能出外网就复用(守护先探),出不了就接管,
    // 原值记进账本、退出还回去。这里只保留「读不到系统代理」这类真正的前置失败。
    preflight() {},
    // 电脑上别的代理(不是我们的)当前开着吗:守护据此决定复用还是接管。PAC 也报,由守护按不可判定处理。
    existingProxy(ours) {
      const isOurs = (value) => isOurProxy(value, ours)
      for (const service of listNetworkServices()) {
        try {
          const pac = readAutoProxyUrl(service)
          if (pac.enabled && pac.url !== '') return { kind: 'pac', url: pac.url, source: service }
          for (const { item } of PROXY_ITEMS) {
            const current = this.read({ service, item })
            if (current?.enabled !== true || isOurs(current)) continue
            return { kind: item === 'socks-proxy' ? 'socks' : 'http', host: current.host, port: current.port, source: `${service}/${item}` }
          }
        } catch (error) {
          if (error?.code === 'TUNNEL_SETTING_TARGET_ABSENT') continue
          throw error
        }
      }
      return undefined
    },
    // 系统代理被改了就修回;退出时别人改过的保留(与 Windows 同一语义)。PAC 开关同样受管。
    reapplyOnChange: (ref) => isManagedItem(ref?.item),
    preserveExternalChanges: (ref) => isManagedItem(ref?.item),
    managedItems(proxy) {
      const value = { enabled: true, host: proxy?.host, port: proxy?.port }
      if (!isProxyValue(value)) throw settingsError('本地代理地址无效')
      // 顺序即写入顺序:先三项手动代理指向来信,最后关 PAC(关掉那一刻客户的流量已经有来信可走);
      // 恢复按账本逆序:先把 PAC 还回去,再还手动代理。PAC 的写入值带上当时系统里的地址 = 写后的完整读数,
      // 退出时判归属要拿它比完整值(GPT-6 复核 2bf4fa9 #2:别人在我们关着 PAC 期间改了地址,那是他的,⛔ 覆盖)。
      return listNetworkServices().flatMap((service) => [
        ...PROXY_ITEMS.map(({ item }) => ({ ref: { service, item }, value })),
        { ref: { service, item: AUTO_PROXY_ITEM }, value: { enabled: false, url: readAutoProxyUrl(service).url } }
      ])
    },
    // 所有权比对始终比完整值:手动代理比开关+主机+端口,PAC 比开关+地址;旧 null 账本只在恢复专用判断中兼容。
    valuesEqual(left, right) {
      if (left === null || right === null) return left === right
      if (isAutoProxyValue(left) || isAutoProxyValue(right)) {
        return isAutoProxyValue(left) && isAutoProxyValue(right) && left.enabled === right.enabled && left.url === right.url
      }
      return isProxyValue(left) && isProxyValue(right) &&
        left.enabled === right.enabled && left.host === right.host && left.port === right.port
    },
    // 「还满足接管要求吗」:PAC 关着就满足(地址被谁改了都不必动);其余项按完整值。
    settingSatisfied(current, written, ref) {
      if (ref?.item === AUTO_PROXY_ITEM) return isAutoProxyValue(current) && current.enabled === false
      return this.valuesEqual(current, written)
    },
    // 修回时写什么:PAC 只关开关、保留对方现在的地址(写后读数 = 关 + 他的地址,归属判断据此);其余项写原值。
    repairValue(ref, current, written) {
      if (ref?.item === AUTO_PROXY_ITEM) return { enabled: false, url: isAutoProxyValue(current) ? current.url : written.url }
      return written
    },
    restoredValueMatches(current, originalValue, writtenValue) {
      if (isAutoProxyValue(originalValue) || isAutoProxyValue(current)) return false
      // networksetup 的 off 保留地址。仅原来无代理且残留地址精确属于本账目时，确认已停用；
      // 原有非空设置仍须完整还原，其他地址或端口的变更绝不能被当作恢复成功。
      const originallyEmpty = originalValue === null ||
        (originalValue?.enabled === false && originalValue.host === '' && originalValue.port === 0)
      if (!originallyEmpty || !isProxyValue(current) || current.enabled !== false) return false
      return (current.host === '' && current.port === 0) ||
        (writtenValue?.enabled === true && current.host === writtenValue.host && current.port === writtenValue.port)
    },
    read(itemRef) {
      if (itemRef?.item === AUTO_PROXY_ITEM) { assertService(itemRef); return readAutoProxyUrl(itemRef.service) }
      const item = proxyItem(itemRef)
      const output = run('networksetup', [item.read, itemRef.service])
      return parseProxy(output)
    },
    write(itemRef, value) {
      if (itemRef?.item === AUTO_PROXY_ITEM) { assertService(itemRef); writeAutoProxy(itemRef.service, value); return }
      const item = proxyItem(itemRef)
      if (value === null) {
        run('networksetup', [item.state, itemRef.service, 'off'])
        return
      }
      if (!isProxyValue(value)) throw settingsError('系统代理设置值无效')
      // networksetup 在关闭代理时仍会保留服务器和端口；恢复该类原值时先写回地址再关闭。
      if (value.enabled === false) {
        if (value.host !== '' || value.port !== 0) {
          run('networksetup', [item.write, itemRef.service, value.host, String(value.port)])
        }
        run('networksetup', [item.state, itemRef.service, 'off'])
        return
      }
      run('networksetup', [item.write, itemRef.service, value.host, String(value.port)])
      run('networksetup', [item.state, itemRef.service, 'on'])
    }
  }
}

function isManagedItem(item) {
  return item === AUTO_PROXY_ITEM || PROXY_ITEMS.some((candidate) => candidate.item === item)
}

function isAutoProxyValue(value) {
  return value !== null && typeof value === 'object' && typeof value.enabled === 'boolean' && typeof value.url === 'string' &&
    !Object.hasOwn(value, 'host') && (!value.enabled || value.url !== '')
}

function assertService(itemRef) {
  if (typeof itemRef?.service !== 'string' || itemRef.service === '') throw settingsError('系统网络服务无效')
}

// PAC 写入:-setautoproxyurl 会顺手把开关打开,所以「关着但保留地址」要先写地址再关;地址为空只动开关。
function writeAutoProxy(service, value) {
  if (value === null) { run('networksetup', ['-setautoproxystate', service, 'off']); return }
  if (!isAutoProxyValue(value)) throw settingsError('系统 PAC 设置值无效')
  if (value.url !== '') run('networksetup', ['-setautoproxyurl', service, value.url])
  run('networksetup', ['-setautoproxystate', service, value.enabled ? 'on' : 'off'])
}

function proxyItem(itemRef) {
  if (typeof itemRef?.service !== 'string' || itemRef.service === '') {
    throw settingsError('系统网络服务无效')
  }
  const item = PROXY_ITEMS.find((candidate) => candidate.item === itemRef.item)
  if (item === undefined) throw settingsError('系统代理项目无效')
  return item
}

function isProxyValue(value) {
  return value !== null && typeof value === 'object' && typeof value.enabled === 'boolean' &&
    typeof value.host === 'string' && Number.isInteger(value.port) && value.port >= 0 && value.port <= 65535 &&
    (!value.enabled || (value.host !== '' && value.port > 0))
}

function listNetworkServices() {
  const output = run('networksetup', ['-listallnetworkservices'])
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('An asterisk') && !line.startsWith('*'))
}

function parseFields(output) {
  const fields = {}
  for (const line of output.split('\n')) {
    const separator = line.indexOf(':')
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
    }
  }
  return fields
}

// networksetup -getautoproxyurl 的读数:「URL: …」+「Enabled: Yes/No」;没设过时 URL 是 (null)。
function readAutoProxyUrl(service) {
  const fields = parseFields(run('networksetup', ['-getautoproxyurl', service]))
  const url = fields.URL ?? ''
  return { enabled: fields.Enabled === 'Yes', url: url === '(null)' ? '' : url }
}

function parseProxy(output) {
  const fields = parseFields(output)
  const port = Number(fields.Port)
  if (!['Yes', 'No'].includes(fields.Enabled) || typeof fields.Server !== 'string' ||
      !/^[0-9]+$/.test(fields.Port ?? '') || !Number.isInteger(port) || port < 0 || port > 65535 ||
      (fields.Enabled === 'Yes' && (!fields.Server || port === 0))) {
    throw settingsError('无法核对系统代理读数')
  }
  if (fields['Authenticated Proxy Enabled'] === '1') throw settingsError('当前代理使用身份验证，请先关闭该代理再连接')
  return { enabled: fields.Enabled === 'Yes', host: fields.Server, port }
}

function settingsError(message) {
  return Object.assign(new Error(message), { code: 'TUNNEL_SETTINGS_NOT_APPLIED' })
}

// 目标网络服务已经不存在(D5):VPN 隧道断开、蓝牙 PAN 关掉、USB 网卡拔掉之后,
// 账本里那条记录再也读不回来。它跟「没权限」是两回事——那条设置随网卡一起消失了,
// 没有东西要还原;当成恢复失败会让客户永远停在「原设置尚未恢复」上,无处可修。
//
// 真实 macOS 26.6.2 对不存在的服务各命令的说法(上线检查实测,evidence/net-mac-networksetup-absent-service.txt):
//   -getwebproxy / -getsecurewebproxy / -getsocksfirewallproxy → 「Unable to find item in network database.」(exit 8)
//   -getautoproxyurl                                          → 「The parameters were not valid.」(exit 4)
//   -getinfo                                                  → 「not a recognized network service.」(本适配器从不调用)
// **前面两句 0.4.8 之前都没认**,所以「服务消失不要求恢复」那句在真机上一次都没走到过。
const ABSENT_SERVICE_PATTERNS = [
  /unable to find item in network database/i,
  /not a recognized network service/i,
  /parameter list is invalid/i
]
// 「参数不对」是含糊说法:服务没了是它,命令本身写错了也是它。凭它直接判定服务消失,
// 会把真正该还原的设置悄悄跳过去。只有再查一遍服务清单、确认它真的不在了,才算消失;
// 清单也查不动就当没消失——宁可报「恢复未完成」,⛔ 悄悄放过一条该还原的设置。
const AMBIGUOUS_ABSENT_PATTERN = /the parameters? (?:were|was) not valid/i

function isAbsentService(text, service) {
  if (ABSENT_SERVICE_PATTERNS.some((pattern) => pattern.test(text))) return true
  if (!AMBIGUOUS_ABSENT_PATTERN.test(text) || typeof service !== 'string' || service === '') return false
  try { return !networkServiceExists(service) } catch { return false }
}

// 存在性按原始清单判:停用的服务前面带 *,它仍然存在,⛔ 跟着 listNetworkServices() 一起被滤掉。
function networkServiceExists(service) {
  return run('networksetup', ['-listallnetworkservices']).split('\n')
    .map((line) => line.trim().replace(/^\*/, ''))
    .some((name) => name !== '' && !name.startsWith('An asterisk') && name === service)
}

function absentTargetError(service) {
  return Object.assign(new Error(`网络服务「${service}」已不存在`), { code: 'TUNNEL_SETTING_TARGET_ABSENT' })
}

// networksetup 自己的错误只有「行首 ** Error: 」一种形状(本机 macOS 实测:服务不存在/参数
// 错误/用法错误全部如此,错误文本走标准输出且伴随非零退出);走到这里的是「退出码 0 的输出里
// 仍有错误行」的兜底。⛔ 回到全文嗅探 error/failed 等英文词:-listallnetworkservices 逐字
// 回显客户起的网卡名,-get*proxy/-getautoproxyurl 逐字回显 Server/PAC 地址——那些是客户的
// 正常数据,不是失败(候选甲-3)。失败判定回到退出码(catch 路径)与结构化解析(parseProxy 等)。
const KNOWN_ERROR_LINE = /^\*\* Error:/m

function run(executable, args) {
  const service = args[1]
  try {
    const output = execFileSync(executable, args, { encoding: 'utf8', timeout: 4_000, env: { ...process.env, LC_ALL: 'C' } })
    if (isAbsentService(output, service)) throw absentTargetError(service)
    if (KNOWN_ERROR_LINE.test(output)) throw settingsError('系统代理设置被拒绝')
    return output
  } catch (error) {
    if (error?.code === 'TUNNEL_SETTINGS_NOT_APPLIED' || error?.code === 'TUNNEL_SETTING_TARGET_ABSENT') throw error
    const text = `${String(error?.stdout ?? '')}\n${String(error?.stderr ?? '')}`
    if (isAbsentService(text, service)) throw absentTargetError(service)
    throw settingsError('无法读取或修改系统代理，请检查系统权限后重试')
  }
}

