// 切换前先扫客户机器上的「隐形状态」。
// 装好了、Key 也填了却连不上、或仍被要求登录，第一真因通常不在工具箱写的配置里，
// 而在这四处残留：shell 启动文件里 export 的旧变量、Windows 注册表里的环境变量、
// 加速器退出后没清掉的系统代理、Claude 没写过的引导标记。
// 这个模块**只读只报告**；清理与恢复在 hidden-state-cleanup.ts。
import { lstat, readFile as readFileImpl, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, sep } from 'node:path'

export type HiddenStateKind = 'shell_export' | 'registry_env' | 'system_proxy' | 'claude_onboarding'
/** blocking＝多半就是连不上的原因 · warning＝会干扰但未必是这次的原因 · info＝只是让客户知道。 */
export type HiddenStateSeverity = 'blocking' | 'warning' | 'info'
export type HiddenStateSoftware = 'codex' | 'claude' | 'hermes'

export interface HiddenStateFinding {
  /** 扫描与清理之间的凭据：界面把它传回来，后台再扫一遍按它对上号。 */
  readonly id: string
  readonly kind: HiddenStateKind
  /** 在哪：文件绝对路径，或注册表键名。 */
  readonly source: string
  readonly name: string
  /** 值一律脱敏（前 4 后 4），⛔ 把完整密钥带上桥。 */
  readonly valueMasked: string
  readonly affects: readonly HiddenStateSoftware[]
  readonly severity: HiddenStateSeverity
  /** 对这几款软件具体有什么影响，写给不懂环境变量的客户看。 */
  readonly impact: string
  readonly suggestion: string
  /** 工具箱能不能替客户处理掉；false＝只报告（配置目录、系统代理都属于这类）。 */
  readonly cleanable: boolean
  /** 这个位置是软链时，真正读写的那个文件。dotfiles 用户的 ~/.bashrc 常常就是。 */
  readonly resolvedSource?: string
  /** shell 启动文件里的行号（从 1 起）。 */
  readonly line?: number
  /** 注册表作用域。 */
  readonly scope?: 'user' | 'machine'
}

/** 这一处读不出来。⛔ 让整份报告抛错——读不到一个文件不该把另外三类也废掉。 */
export interface HiddenStateUnreadable {
  readonly source: string
  readonly reason: string
}

export interface HiddenStateReport {
  readonly scannedAt: string
  readonly platform: string
  readonly findings: readonly HiddenStateFinding[]
  readonly unreadable: readonly HiddenStateUnreadable[]
}

export interface SystemProxy {
  readonly enabled: boolean
  readonly host: string
  readonly port: number | null
  /** 原样留一份，界面要说「指向哪里」。 */
  readonly raw: string
  /** `manual`＝明确的转发地址；`pac`＝自动配置脚本；`winhttp`＝系统级服务代理。后两类按清单第 5 条只报告。 */
  readonly mode?: 'manual' | 'pac' | 'winhttp'
}

/** `plain`＝不是软链 · `link-inside`＝软链且目标在家目录之下的普通文件 · 其余两种不检查。 */
export type PathKind = 'plain' | 'link-inside' | 'link-outside' | 'link-broken'

export interface PathVerdict {
  readonly kind: PathKind
  /** 落到底的真实路径；不是软链时与原路径相同。 */
  readonly target: string
}

export interface HiddenStateDeps {
  readonly platform: string
  readonly home: string
  readonly env: NodeJS.ProcessEnv
  readonly readFile?: (path: string) => Promise<string | undefined>
  /** 判这个位置是不是软链、链到哪。dotfiles 用户把 rc 文件软链走是常态。 */
  readonly resolvePath?: (path: string, home: string) => Promise<PathVerdict>
  readonly exec?: (command: string, args: readonly string[]) => Promise<string>
  readonly isPortListening?: (port: number) => Promise<boolean>
  readonly readSystemProxy?: () => Promise<SystemProxy | null>
  readonly now?: () => Date
}

const softwareLabels: Readonly<Record<HiddenStateSoftware, string>> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }

/** 跟着这三个变量走配置目录，⛔ 删掉它们：客户是有意搬家的，工具箱该跟过去写。 */
const configRootNames: Readonly<Record<string, HiddenStateSoftware>> = {
  CLAUDE_CONFIG_DIR: 'claude',
  CODEX_HOME: 'codex',
  HERMES_HOME: 'hermes'
}
const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const
// 名单按「这条变量被哪款软件读进去」排，⛔ 按厂商排：客户关心的是哪个 AI 会出问题。
const vendorPrefixes: readonly (readonly [string, readonly HiddenStateSoftware[]])[] = [
  ['ANTHROPIC_', ['claude']],
  ['CLAUDE_CODE_', ['claude']],
  ['OPENAI_', ['codex', 'hermes']],
  ['DEEPSEEK_', ['hermes']],
  ['KIMI_', ['hermes']],
  ['MOONSHOT_', ['hermes']],
  ['GLM_', ['hermes']],
  ['ZAI_', ['hermes']]
]

export const CLAUDE_ONBOARDING_KEY = 'hasCompletedOnboarding'
export const CLAUDE_REJECTED_KEYS = 'customApiKeyResponses.rejected'

/** 前 4 后 4；短到看不出前后就整条盖掉，⛔ 让一把短 Key 从界面上漏出去。 */
export function maskValue(value: string): string {
  const text = value.trim()
  if (text.length === 0) return '(空值)'
  if (text.length <= 8) return '•'.repeat(text.length)
  return `${text.slice(0, 4)}••••${text.slice(-4)}`
}

// 名字里带这几个词的才是密钥，才盖；路径与地址原样显示——
// 客户看不懂 `/opt••••home` 就判断不了要不要停用（pingxia-0d 09-13 验收定）。
const secretNames = /KEY|TOKEN|SECRET|PASSWORD|AUTH/

export function shouldMask(name: string): boolean {
  return secretNames.test(name.toUpperCase())
}

/** 地址里内嵌的账号密码照样是密钥，**⛔ 因为名字里没有 KEY 就整条显示出来**。 */
export function redactCredentials(value: string): string {
  const text = value.trim()
  if (text === '') return '(空值)'
  const cleaned = text.replace(/(\/\/)[^/@\s]+:[^/@\s]+@/g, '$1••••@')
  return cleaned.length <= 160 ? cleaned : `${cleaned.slice(0, 160)}…`
}

/** 上屏用的值：密钥盖掉，其余原样（但抹掉内嵌账密）。 */
export function displayValue(name: string, value: string): string {
  return shouldMask(name) ? maskValue(value) : redactCredentials(value)
}

export interface NameVerdict {
  readonly affects: readonly HiddenStateSoftware[]
  readonly cleanable: boolean
  readonly severity: HiddenStateSeverity
  readonly impact: string
  readonly suggestion: string
}

function listLabels(affects: readonly HiddenStateSoftware[]): string {
  return affects.map((item) => softwareLabels[item]).join('、')
}

/**
 * Claude Code 的 settings.json 里 `env` 压过终端里的变量（官方文档），所以同一条 export
 * 对 Claude 只是「切回官方后才留下的残留」，对 Codex / Hermes 却是**进程环境优先、当场劫持**。
 * 同一条变量在不同软件上不是一回事，报告里必须说清楚是哪一种。
 */
function impactFor(affects: readonly HiddenStateSoftware[]): string {
  const hijacks = affects.filter((item) => item !== 'claude')
  if (hijacks.length === 0) {
    return 'Claude Code 以工具箱写入的配置为准（官方文档：settings.json 里的设置压过终端里的变量），这条只在你切回官方账号之后才会留下影响。'
  }
  const rest = affects.includes('claude') ? '；对 Claude Code 则要等切回官方账号后才显出来' : ''
  return `${listLabels(hijacks)} 用的是启动时从终端带进去的设置，这条会盖掉工具箱写的接入——表现就是 Key 填好了仍然连不上、或者仍被要求登录${rest}。`
}

/** 名字在不在名单里、属于哪一类。不在名单里返回 null，⛔ 把客户自己的变量也报出来吓人。 */
export function classifyName(rawName: string): NameVerdict | null {
  const name = rawName.toUpperCase()
  const configRoot = configRootNames[name]
  if (configRoot !== undefined) {
    return {
      affects: [configRoot],
      cleanable: false,
      severity: 'info',
      impact: `${softwareLabels[configRoot]} 的配置被指到了另一个目录。工具箱会跟着这个目录写，不用清理；但别的工具如果写在默认目录，就会写了不生效。`,
      suggestion: '保留即可。工具箱会跟着这个目录读写配置。'
    }
  }
  // NO_PROXY 不是代理，是「不走代理」的豁免名单。停掉它等于让 127.0.0.1 也走代理——
  // 工具箱的本机网关就找不到了。清单第 5 条还让客户把 127.0.0.1 加进去，⛔ 自己拆自己的台。
  if (name === 'NO_PROXY') {
    return {
      affects: ['codex', 'claude', 'hermes'],
      cleanable: false,
      severity: 'info',
      impact: 'NO_PROXY 是「不走代理」的白名单：列在里面的地址直连。工具箱的本机网关靠它才不会被代理拦住，停用它会让 AI 连不上本机网关。',
      suggestion: '保留即可。确认 127.0.0.1 和 localhost 都在这份名单里。'
    }
  }
  if ((proxyNames as readonly string[]).includes(name)) {
    return {
      affects: ['codex', 'claude', 'hermes'],
      cleanable: true,
      severity: 'warning',
      impact: '终端里设了上网代理，三款 AI 发出去的请求都会先走它。代理如果已经关掉或者到不了模型服务商，就会连不上。',
      suggestion: '还在用这个代理就保留；已经不用了，点一下停用，随时可以恢复。'
    }
  }
  const vendor = vendorPrefixes.find(([prefix]) => name.startsWith(prefix))
  if (vendor === undefined) return null
  const [, affects] = vendor
  return {
    affects,
    cleanable: true,
    severity: affects.some((item) => item !== 'claude') ? 'blocking' : 'warning',
    impact: impactFor(affects),
    suggestion: '点一下停用，工具箱会先备份再把这行注释掉，随时可以恢复。'
  }
}

export interface ShellAssignment {
  readonly name: string
  readonly value: string
  /** 从 1 起。 */
  readonly line: number
  /** 整行被 # 注释掉了：**⛔ 当成生效中的设置报出来**。 */
  readonly commented: boolean
}

const posixExport = /^\s*(?:#+\s*)?export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const fishSet = /^\s*(?:#+\s*)?set\s+((?:-[A-Za-z-]+\s+)+)([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/

function unquote(raw: string): string {
  let text = raw.trim()
  if (text.endsWith(';')) text = text.slice(0, -1).trim()
  const quoted = text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  if (quoted) return text.slice(1, -1)
  const comment = text.indexOf(' #')
  return comment === -1 ? text : text.slice(0, comment).trim()
}

/** 只认真正会导出到子进程的写法：posix 的 `export NAME=值`、fish 的 `set -gx NAME 值`。 */
export function parseShellAssignments(contents: string, syntax: 'posix' | 'fish'): readonly ShellAssignment[] {
  const found: ShellAssignment[] = []
  contents.split(/\r?\n/).forEach((raw, index) => {
    // CRLF 文件按 '\n' 切会在行尾留下 \r，而正则里的 `.` 不匹配 \r——不剥掉就整行匹配不上。
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const commented = text.trimStart().startsWith('#')
    if (syntax === 'fish') {
      const match = fishSet.exec(text)
      if (match === null) return
      const exported = match[1].split(/\s+/).some((flag) => flag.startsWith('-') && flag.replace(/^-+/, '').includes('x'))
      if (!exported) return
      found.push({ name: match[2], value: unquote(match[3]), line: index + 1, commented })
      return
    }
    const match = posixExport.exec(text)
    if (match === null) return
    found.push({ name: match[1], value: unquote(match[2]), line: index + 1, commented })
  })
  return found
}

/** 客户可能用任意一个 shell；七个文件都看一遍，⛔ 只看 .zshrc。 */
export function shellStartupFiles(home: string): readonly { readonly path: string; readonly syntax: 'posix' | 'fish' }[] {
  return [
    { path: join(home, '.zshrc'), syntax: 'posix' },
    { path: join(home, '.zprofile'), syntax: 'posix' },
    { path: join(home, '.zshenv'), syntax: 'posix' },
    { path: join(home, '.bashrc'), syntax: 'posix' },
    { path: join(home, '.bash_profile'), syntax: 'posix' },
    { path: join(home, '.profile'), syntax: 'posix' },
    { path: join(home, '.config', 'fish', 'config.fish'), syntax: 'fish' }
  ]
}

export const REGISTRY_USER_KEY = 'HKCU\\Environment'
export const REGISTRY_MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const registryRow = /^\s{2,}(\S+)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/

export interface RegistryValue {
  readonly name: string
  readonly type: string
  readonly value: string
}

/** `reg query` 的输出：三列靠多空格分隔，值本身可以带空格。 */
export function parseRegistryQuery(output: string): readonly RegistryValue[] {
  const values: RegistryValue[] = []
  for (const text of output.split(/\r?\n/)) {
    const match = registryRow.exec(text)
    if (match === null) continue
    values.push({ name: match[1], type: match[2], value: match[3].trim() })
  }
  return values
}

/**
 * mac 的 `scutil --proxy`：HTTPS 优先，没开看 HTTP，再看 SOCKS（专线）。
 * 都没开而 PAC 开着也要报——公司内网客户靠 PAC 上网，漏报等于说「本机没有残留」。
 */
export function parseScutilProxy(output: string): SystemProxy | null {
  const field = (key: string): string | undefined => {
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(output)
    return match === null ? undefined : match[1].trim()
  }
  for (const scheme of ['HTTPS', 'HTTP', 'SOCKS'] as const) {
    if (field(`${scheme}Enable`) !== '1') continue
    const host = field(`${scheme}Proxy`) ?? ''
    const port = Number.parseInt(field(`${scheme}Port`) ?? '', 10)
    return { enabled: true, host, port: Number.isFinite(port) ? port : null, raw: port ? `${host}:${port}` : host }
  }
  if (field('ProxyAutoConfigEnable') === '1') {
    const url = field('ProxyAutoConfigURLString')
    return { enabled: true, host: '', port: null, mode: 'pac',
      raw: url !== undefined && url !== '' ? `PAC: ${url}` : '代理自动配置脚本（PAC）' }
  }
  return null
}

const WINDOWS_PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/**
 * Windows 的系统代理在注册表：ProxyEnable 是开关，ProxyServer 是地址。
 * AutoConfigURL（PAC 脚本）和 AutoDetect 没有开关位，存在/非零即生效；按清单第 5 条只报告，⛔ 清理。
 */
export function parseWindowsProxy(output: string): SystemProxy | null {
  const values = parseRegistryQuery(output)
  const dword = (name: string): number | undefined => {
    const raw = values.find((item) => item.name.toLowerCase() === name)?.value
    if (raw === undefined) return undefined
    const parsed = Number.parseInt(raw, 16)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if ((dword('proxyenable') ?? 0) !== 0) {
    const server = values.find((item) => item.name.toLowerCase() === 'proxyserver')?.value ?? ''
    // `host=127.0.0.1:7890;https=...` 这种按协议分写的形式，取第一段就够判本机端口。
    const first = server.split(';')[0].replace(/^[a-z]+=/i, '').trim()
    const [host, port] = first.split(':')
    const parsed = Number.parseInt(port ?? '', 10)
    return { enabled: true, host: host ?? '', port: Number.isFinite(parsed) ? parsed : null, raw: server, mode: 'manual' }
  }
  const autoConfig = values.find((item) => item.name.toLowerCase() === 'autoconfigurl')?.value.trim()
  if (autoConfig !== undefined && autoConfig !== '') {
    return { enabled: true, host: '', port: null, mode: 'pac', raw: `PAC: ${autoConfig}` }
  }
  if ((dword('autodetect') ?? 0) !== 0) {
    return { enabled: true, host: '', port: null, mode: 'pac', raw: '自动检测代理设置（AutoDetect）' }
  }
  return null
}

/**
 * `netsh winhttp show proxy`：系统级 WinHTTP 代理，用户级注册表里看不见它。
 * `Direct access` 才算没有；配置了就只报告（清单第 5 条），⛔ 清理。
 */
export function parseWindowsWinHttpProxy(output: string): SystemProxy | null {
  if (/Direct access \(no proxy server\)/i.test(output)) return null
  const server = /^\s*Proxy Server\(s\)\s*:\s*(\S.*)$/im.exec(output)?.[1]?.trim()
  if (server === undefined || server === '') return null
  const first = server.split(';')[0].replace(/^[a-z]+=/i, '').trim()
  const [host, port] = first.split(':')
  const parsed = Number.parseInt(port ?? '', 10)
  return { enabled: true, host: host ?? '', port: Number.isFinite(parsed) ? parsed : null, raw: server, mode: 'winhttp' }
}

const loopbackHosts = ['127.0.0.1', 'localhost', '::1', '[::1]']

export function isLoopback(host: string): boolean {
  return loopbackHosts.includes(host.trim().toLowerCase())
}

function defaultReadFile(path: string): Promise<string | undefined> {
  return (async () => {
    try {
      const info = await lstat(path)
      // 只读普通文件、不跟软链、不读大文件：这些都是客户家目录里的东西，⛔ 顺着链接跑到别处去。
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return undefined
      return await readFileImpl(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  })()
}

/**
 * 软链的启动文件**⛔ 静默跳过**——那正是客户「明明有残留却扫不出来」的一类。
 * 目标仍在家目录之下的普通文件就照常读；出了家目录或链断了，记一条 unreadable 说清楚。
 * mac 上 `/var` 本身就是到 `/private/var` 的软链，所以两边都要先落到真实路径再比。
 */
async function defaultResolvePath(path: string, home: string): Promise<PathVerdict> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return { kind: 'plain', target: path }
  }
  if (!info.isSymbolicLink()) return { kind: 'plain', target: path }
  try {
    const [target, root] = await Promise.all([realpath(path), realpath(home)])
    const inside = target === root || target.startsWith(`${root}${sep}`)
    const stats = await lstat(target)
    return { kind: inside && stats.isFile() ? 'link-inside' : 'link-outside', target }
  } catch {
    return { kind: 'link-broken', target: path }
  }
}

function linkReason(verdict: PathVerdict): string {
  return verdict.kind === 'link-broken'
    ? '是链接文件，指向的目标不在了，未检查'
    : `是链接文件，指向家目录以外（${verdict.target}），未检查`
}

/** 有界的本机端口探测；残留代理扫描与残留死地址核对共用。它只连 127.0.0.1，⛔ 去碰外部地址。 */
export function defaultIsPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 700 })
    const settle = (listening: boolean): void => { socket.destroy(); resolve(listening) }
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function defaultExec(): Promise<string> {
  throw new Error('HIDDEN_STATE_EXEC_MISSING')
}

function findingId(kind: HiddenStateKind, source: string, name: string, line?: number): string {
  return JSON.stringify([kind, source, name, line ?? 0])
}

interface ShellScanDeps {
  readonly home: string
  readonly readFile: NonNullable<HiddenStateDeps['readFile']>
  readonly resolvePath: NonNullable<HiddenStateDeps['resolvePath']>
}

async function scanShellFiles(deps: ShellScanDeps, findings: HiddenStateFinding[], unreadable: HiddenStateUnreadable[]): Promise<void> {
  for (const file of shellStartupFiles(deps.home)) {
    const location = await deps.resolvePath(file.path, deps.home).catch((): PathVerdict => ({ kind: 'plain', target: file.path }))
    if (location.kind === 'link-outside' || location.kind === 'link-broken') {
      unreadable.push({ source: file.path, reason: linkReason(location) })
      continue
    }
    let contents: string | undefined
    try {
      contents = await deps.readFile(location.target)
    } catch (error) {
      unreadable.push({ source: file.path, reason: reasonOf(error) })
      continue
    }
    if (contents === undefined) continue
    const linked = location.kind === 'link-inside'
    for (const assignment of parseShellAssignments(contents, file.syntax)) {
      if (assignment.commented) continue
      const verdict = classifyName(assignment.name)
      if (verdict === null) continue
      findings.push({
        id: findingId('shell_export', file.path, assignment.name, assignment.line),
        // 客户看到的是链接本身，真正改的是目标文件——两个都记下来。
        kind: 'shell_export', source: file.path, name: assignment.name, valueMasked: displayValue(assignment.name, assignment.value),
        ...(linked ? { resolvedSource: location.target } : {}), line: assignment.line, ...verdict
      })
    }
  }
}

async function scanRegistry(exec: NonNullable<HiddenStateDeps['exec']>,
  findings: HiddenStateFinding[], unreadable: HiddenStateUnreadable[]): Promise<void> {
  for (const [key, scope] of [[REGISTRY_USER_KEY, 'user'], [REGISTRY_MACHINE_KEY, 'machine']] as const) {
    let output: string
    try {
      output = await exec('reg', ['query', key])
    } catch (error) {
      unreadable.push({ source: key, reason: reasonOf(error) })
      continue
    }
    for (const value of parseRegistryQuery(output)) {
      const verdict = classifyName(value.name)
      if (verdict === null) continue
      findings.push({
        id: findingId('registry_env', key, value.name),
        kind: 'registry_env', source: key, name: value.name, valueMasked: displayValue(value.name, value.value), scope, ...verdict
      })
    }
  }
}

/** 一次代理读取的结果：`ok` 里装答案（null＝确认没有），读失败装 `failed`。 */
type ProxyAnswer = { readonly ok: SystemProxy | null } | { readonly failed: unknown }

async function readProxy(deps: HiddenStateDeps, exec: NonNullable<HiddenStateDeps['exec']>): Promise<SystemProxy | null> {
  if (deps.readSystemProxy !== undefined) return deps.readSystemProxy()
  if (deps.platform === 'darwin') return parseScutilProxy(await exec('scutil', ['--proxy']))
  if (deps.platform !== 'win32') return null
  // Windows 把代理藏在两处：用户级 Internet Settings（注册表）和系统级 WinHTTP（netsh）。
  // 哪处读到了就按哪处报；两处都没有而又有读失败的，才当「读不到」记进 unreadable，⛔ 当成「没有残留」。
  const attempt = async (run: () => Promise<SystemProxy | null>): Promise<ProxyAnswer> => {
    try { return { ok: await run() } } catch (error) { return { failed: error } }
  }
  const answer = (value: ProxyAnswer): SystemProxy | null | undefined => ('ok' in value ? value.ok : undefined)
  const [settings, winhttp] = await Promise.all([
    attempt(async () => parseWindowsProxy(await exec('reg', ['query', WINDOWS_PROXY_KEY]))),
    attempt(async () => parseWindowsWinHttpProxy(await exec('netsh', ['winhttp', 'show', 'proxy'])))
  ])
  const settingsProxy = answer(settings)
  const winhttpProxy = answer(winhttp)
  // 注册表配了按注册表报；注册表没有而 WinHTTP 配了按 WinHTTP 报。
  if (settingsProxy !== null && settingsProxy !== undefined) return settingsProxy
  if (winhttpProxy !== null && winhttpProxy !== undefined) return winhttpProxy
  // 两处都没报出代理：哪一处没读到都要记成「读不到」，⛔ 静默当成「没有残留」。
  if (settingsProxy === undefined) throw ('failed' in settings ? settings.failed : undefined)
  if (winhttpProxy === undefined) throw ('failed' in winhttp ? winhttp.failed : undefined)
  return null
}

async function scanSystemProxy(deps: HiddenStateDeps, exec: NonNullable<HiddenStateDeps['exec']>,
  isPortListening: NonNullable<HiddenStateDeps['isPortListening']>,
  findings: HiddenStateFinding[], unreadable: HiddenStateUnreadable[]): Promise<void> {
  let proxy: SystemProxy | null
  try {
    proxy = await readProxy(deps, exec)
  } catch (error) {
    unreadable.push({ source: '系统代理设置', reason: reasonOf(error) })
    return
  }
  if (proxy === null || !proxy.enabled) return
  const source = deps.platform === 'win32' ? WINDOWS_PROXY_KEY : '系统设置 · 网络 · 代理'
  const base = { id: findingId('system_proxy', source, '系统代理'), kind: 'system_proxy' as const, source, name: '系统代理',
    valueMasked: redactCredentials(proxy.raw), affects: ['codex', 'claude', 'hermes'] as const, cleanable: false }
  // PAC / WinHTTP 按清单第 5 条只报告：不做端口探测、不判残留，⛔ 清理。
  if (proxy.mode === 'pac' || proxy.mode === 'winhttp') {
    findings.push({ ...base, severity: 'info',
      impact: proxy.mode === 'pac'
        ? '这台机器开了代理自动配置脚本（PAC），AI 的请求会按脚本选择出口。公司内网常用这种方式，PAC 到不了模型服务商时表现就是连不上。'
        : '这台机器配置了系统级 WinHTTP 代理，部分程序的请求会先走它。',
      suggestion: '工具箱只报告这一类代理，不会去改它；AI 连不上时，先确认这条代理策略能访问模型服务商。' })
    return
  }
  // 指向本机端口、那个端口却没人在听 ⇒ 加速器退出后没清干净。指向别的地址只报「有代理」，**⛔ 判成残留**。
  if (!isLoopback(proxy.host) || proxy.port === null) {
    findings.push({ ...base, severity: 'info',
      impact: '这台机器设了上网代理，三款 AI 的请求都会先走它。',
      suggestion: '还在用就不用管；如果 AI 连不上，先确认这个代理能访问模型服务商。' })
    return
  }
  let listening: boolean
  try {
    listening = await isPortListening(proxy.port)
  } catch (error) {
    unreadable.push({ source, reason: reasonOf(error) })
    return
  }
  if (listening) {
    findings.push({ ...base, severity: 'info',
      impact: '这台机器的上网代理指向本机，程序正在运行，三款 AI 的请求都会先走它。',
      suggestion: '正常，不用处理。' })
    return
  }
  findings.push({ ...base, severity: 'blocking',
    impact: `这台机器的上网代理指向本机 ${proxy.port} 端口，但那个端口现在没有程序在听——多半是上次用的加速器退出后没清干净。所有 AI 的请求都会发到一个不存在的地方，表现就是全部连不上。`,
    suggestion: '到「网络」里点一次连接，工具箱会把代理接回到能用的通道；已经不用加速器了，就到系统设置 → 网络 → 代理里把它关掉。' })
}

interface ClaudeConfigShape {
  readonly hasCompletedOnboarding?: unknown
  readonly customApiKeyResponses?: { readonly rejected?: unknown }
}

/** `CLAUDE_CONFIG_DIR` 一设，这份记忆就跟着搬家；⛔ 写死 ~/.claude.json。 */
export function claudeConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  const root = env.CLAUDE_CONFIG_DIR
  return root !== undefined && root.trim() !== '' ? join(root, '.claude.json') : join(home, '.claude.json')
}

async function scanClaudeOnboarding(deps: HiddenStateDeps, readFile: NonNullable<HiddenStateDeps['readFile']>,
  resolvePath: NonNullable<HiddenStateDeps['resolvePath']>,
  findings: HiddenStateFinding[], unreadable: HiddenStateUnreadable[]): Promise<void> {
  const path = claudeConfigPath(deps.home, deps.env)
  // 这份记忆也常被 dotfiles 软链走，同一套判法。
  const location = await resolvePath(path, deps.home).catch((): PathVerdict => ({ kind: 'plain', target: path }))
  if (location.kind === 'link-outside' || location.kind === 'link-broken') {
    unreadable.push({ source: path, reason: linkReason(location) })
    return
  }
  let contents: string | undefined
  try {
    contents = await readFile(location.target)
  } catch (error) {
    unreadable.push({ source: path, reason: reasonOf(error) })
    return
  }
  let config: ClaudeConfigShape
  try {
    config = contents === undefined ? {} : (JSON.parse(contents) as ClaudeConfigShape)
  } catch (error) {
    unreadable.push({ source: path, reason: reasonOf(error) })
    return
  }
  if (config.hasCompletedOnboarding !== true) {
    findings.push({
      id: findingId('claude_onboarding', path, CLAUDE_ONBOARDING_KEY),
      kind: 'claude_onboarding', source: path, name: CLAUDE_ONBOARDING_KEY, valueMasked: '未写入',
      ...(location.kind === 'link-inside' ? { resolvedSource: location.target } : {}),
      affects: ['claude'], severity: 'blocking', cleanable: true,
      impact: 'Claude Code 还没记下「已经过了首次引导」，启动时会拦在引导页上，客户会以为是 Key 没配好。',
      suggestion: '点一下写入，Claude Code 下次启动就直接可用。'
    })
  }
  const rejected = config.customApiKeyResponses?.rejected
  if (Array.isArray(rejected) && rejected.length > 0) {
    findings.push({
      id: findingId('claude_onboarding', path, CLAUDE_REJECTED_KEYS),
      kind: 'claude_onboarding', source: path, name: CLAUDE_REJECTED_KEYS, valueMasked: `${rejected.length} 条`,
      affects: ['claude'], severity: 'warning', cleanable: false,
      impact: 'Claude Code 记住了你之前拒绝过的几把 Key，再填同一把会被直接跳过。',
      suggestion: '工具箱用的写入方式不会再弹这个确认，这条通常不用管。'
    })
  }
}

function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return '没有读取权限'
  return error instanceof Error && error.message !== '' ? error.message : '读取失败'
}

/**
 * 扫四类隐形状态。任何一处读不出来只记进 `unreadable`，**⛔ 让整份报告抛错**；
 * 一条都没有时返回空报告，**⛔ 报「未知」**。
 */
export async function scanHiddenState(deps: HiddenStateDeps): Promise<HiddenStateReport> {
  const readFile = deps.readFile ?? defaultReadFile
  const resolvePath = deps.resolvePath ?? defaultResolvePath
  const exec = deps.exec ?? defaultExec
  const isPortListening = deps.isPortListening ?? defaultIsPortListening
  const findings: HiddenStateFinding[] = []
  const unreadable: HiddenStateUnreadable[] = []

  await scanShellFiles({ home: deps.home, readFile, resolvePath }, findings, unreadable)
  if (deps.platform === 'win32') await scanRegistry(exec, findings, unreadable)
  await scanSystemProxy(deps, exec, isPortListening, findings, unreadable)
  await scanClaudeOnboarding(deps, readFile, resolvePath, findings, unreadable)

  const order: Readonly<Record<HiddenStateSeverity, number>> = { blocking: 0, warning: 1, info: 2 }
  return {
    scannedAt: (deps.now?.() ?? new Date()).toISOString(),
    platform: deps.platform,
    // 最可能是这次连不上的原因排最前，客户从上往下处理就行。
    findings: [...findings].sort((left, right) => order[left.severity] - order[right.severity]),
    unreadable
  }
}
