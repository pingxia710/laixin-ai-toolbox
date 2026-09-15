// 别的工具留下的死地址：配置里的接口地址指着 127.0.0.1 的某个端口，而那个端口上没有程序在监听
// ——多半是 CC Switch 之类的代理工具退出后没清干净。客户不知道有过这么一段死配置，再出问题只能整个重来。
// 这里只负责认出它、把话说全（点名端口、说清来历，纪律 2）；先备份再覆盖是接管流程本来的行为，⛔ 在这里改接管行为。
import { isLoopback, defaultIsPortListening } from './hidden-state'

export interface ResidualAddress {
  /** 报给客户看的地址：协议 + 主机 + 端口 + 路径，凭据已去掉，⛔ 当成配置原文用。 */
  readonly url: string
  readonly host: string
  readonly port: number
}

/** 从配置里读到的接口地址认出「本机死地址」的候选；不是本机、不是 URL、没有端口都不算。 */
export function residualLoopbackAddress(url: string | undefined): ResidualAddress | null {
  const text = url?.trim()
  if (text === undefined || text === '') return null
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!isLoopback(parsed.hostname)) return null
  const explicit = parsed.port !== '' ? Number.parseInt(parsed.port, 10) : NaN
  const port = Number.isFinite(explicit) ? explicit : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return null
  // 报给客户的地址只保留协议 + 主机 + 端口 + 路径：凭据可能就嵌在地址里（令牌当用户名的写法很常见），
  // URL 解析完重新拼，⛔ 用正则去删、⛔ 原样带过桥。
  parsed.username = ''
  parsed.password = ''
  return { url: parsed.toString(), host: parsed.hostname, port }
}

/** 端口探测委托给隐形状态扫描的同一个实现；探测失败由调用方按「有人在听」处理。 */
export function isPortListening(port: number): Promise<boolean> {
  return defaultIsPortListening(port)
}

/** 报给客户的话：点名端口、写上原地址、说清来历，再讲明工具箱会怎么做。 ⛔ 带配置里的 Key。 */
export function residualAddressNote(software: string, address: ResidualAddress): string {
  return `检测到别的工具留下的死配置：${software} 的接口地址指着本机 ${address.port} 端口（${address.url}），` +
    '那个端口现在没有程序在监听，多半是 CC Switch 之类的代理工具退出后没清掉。' +
    '工具箱接管时会先备份再覆盖这段地址，你原来的设置不会丢。'
}

/**
 * 从 Codex 的 config.toml 里找「当前生效」的接口地址：顶层 `model_provider` 指到哪张表，
 * 就读那张表的 `base_url`。这是给核对用的保守读取，⛔ 当成完整的 TOML 解析器用。
 */
export function baseUrlFromCodexToml(contents: string): string | undefined {
  const topLevel = new Map<string, string>()
  const providerTables = new Map<string, Map<string, string>>()
  let currentTable: string | undefined
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const table = /^\[([^\]]+)\]$/.exec(line)
    if (table !== null) {
      currentTable = table[1].split('.').map(part => part.trim().replace(/^"(.*)"$/, '$1')).join('.')
      continue
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line)
    if (assignment === null) continue
    const [, key, value] = assignment
    if (currentTable === undefined) topLevel.set(key, value)
    else {
      let bucket = providerTables.get(currentTable)
      if (bucket === undefined) { bucket = new Map(); providerTables.set(currentTable, bucket) }
      bucket.set(key, value)
    }
  }
  const active = topLevel.get('model_provider')
  if (active === undefined) return undefined
  return providerTables.get(`model_providers.${active}`)?.get('base_url')
}
