import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyName, claudeConfigPath, displayValue, isLoopback, maskValue, parseRegistryQuery, parseScutilProxy, parseShellAssignments,
  parseWindowsProxy, parseWindowsWinHttpProxy, redactCredentials, scanHiddenState, shellStartupFiles, shouldMask,
  type HiddenStateDeps, type HiddenStateFinding, type HiddenStateReport
} from '../../app/main/ai-access/hidden-state'

// 全部在临时目录里造，⛔ 碰本机的 ~/.zshrc ~/.claude.json。
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function temporaryHome(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'laixin-hidden-state-'))
  homes.push(home)
  for (const [name, contents] of Object.entries(files)) {
    const path = join(home, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents, 'utf8')
  }
  return home
}

const onboarded = JSON.stringify({ hasCompletedOnboarding: true })
const quietProxy = async (): Promise<null> => null
function deps(home: string, over: Partial<HiddenStateDeps> = {}): HiddenStateDeps {
  return { platform: 'darwin', home, env: {}, readSystemProxy: quietProxy, now: () => new Date('2026-09-13T11:00:00Z'), ...over }
}
const named = (report: HiddenStateReport, name: string): HiddenStateFinding | undefined =>
  report.findings.find((finding) => finding.name === name)

describe('隐形状态 · shell 启动文件里的旧设置', () => {
  it('七个启动文件都看，fish 用它自己的写法', () => {
    expect(shellStartupFiles('/home/x').map((file) => file.path.replace('/home/x/', ''))).toEqual([
      '.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile', '.config/fish/config.fish'
    ])
    expect(shellStartupFiles('/home/x').at(-1)?.syntax).toBe('fish')
  })

  it('只认真正会带进子进程的写法：export 算，光赋值不算，被注释掉的不算', () => {
    const contents = [
      'export ANTHROPIC_AUTH_TOKEN=sk-ant-0123456789abcdef',
      '# export OPENAI_API_KEY=sk-commented-0123456789',
      '#export DEEPSEEK_API_KEY=sk-tight-0123456789',
      'KIMI_API_KEY=sk-not-exported-0123456789',
      'export PATH="$PATH:/opt/bin"'
    ].join('\n')
    const parsed = parseShellAssignments(contents, 'posix')
    expect(parsed.map((item) => [item.name, item.commented])).toEqual([
      ['ANTHROPIC_AUTH_TOKEN', false], ['OPENAI_API_KEY', true], ['DEEPSEEK_API_KEY', true], ['PATH', false]
    ])
  })

  it('fish 的 set 要带 x 才是导出；不带 x 的不报', () => {
    const parsed = parseShellAssignments(['set -gx OPENAI_API_KEY sk-fish-0123456789', 'set -g GLM_BASE_URL https://example.invalid',
      'set -x -g KIMI_API_KEY sk-fish-two-0123456789'].join('\n'), 'fish')
    expect(parsed.map((item) => item.name)).toEqual(['OPENAI_API_KEY', 'KIMI_API_KEY'])
  })

  it('值一律脱敏，短到看不出前后就整条盖掉', () => {
    expect(maskValue('sk-ant-0123456789abcdef')).toBe('sk-a••••cdef')
    expect(maskValue('short')).toBe('•••••')
    expect(maskValue('  ')).toBe('(空值)')
    expect(maskValue('sk-ant-0123456789abcdef')).not.toContain('0123456789')
  })

  it('注释掉的行不报；名单外的自家变量不报', async () => {
    const home = await temporaryHome({
      '.zshrc': ['export ANTHROPIC_AUTH_TOKEN=sk-ant-0123456789abcdef', '# export OPENAI_API_KEY=sk-old-0123456789', 'export MY_OWN_TOOL=1'].join('\n'),
      '.claude.json': onboarded
    })
    const report = await scanHiddenState(deps(home))
    expect(report.findings.map((finding) => finding.name)).toEqual(['ANTHROPIC_AUTH_TOKEN'])
    expect(named(report, 'ANTHROPIC_AUTH_TOKEN')).toMatchObject({
      kind: 'shell_export', source: join(home, '.zshrc'), line: 1, valueMasked: 'sk-a••••cdef', affects: ['claude'], cleanable: true
    })
  })

  it('同一条变量对不同软件不是一回事：Claude 被配置压过只是残留，Codex/Hermes 是当场劫持', async () => {
    const home = await temporaryHome({
      '.zshrc': 'export ANTHROPIC_AUTH_TOKEN=sk-ant-0123456789abcdef',
      '.bashrc': 'export OPENAI_API_KEY=sk-openai-0123456789abcdef',
      '.claude.json': onboarded
    })
    const report = await scanHiddenState(deps(home))
    expect(named(report, 'ANTHROPIC_AUTH_TOKEN')).toMatchObject({ severity: 'warning', affects: ['claude'] })
    expect(named(report, 'ANTHROPIC_AUTH_TOKEN')?.impact).toContain('切回官方账号')
    expect(named(report, 'OPENAI_API_KEY')).toMatchObject({ severity: 'blocking', affects: ['codex', 'hermes'] })
    // 最可能是这次连不上的原因排最前。
    expect(report.findings[0]?.name).toBe('OPENAI_API_KEY')
  })

  it('代理变量大小写两套都认；配置目录只报告 ⛔ 清理', async () => {
    const home = await temporaryHome({
      '.zprofile': ['export https_proxy=http://127.0.0.1:7890', 'export NO_PROXY=localhost', 'export CODEX_HOME=/opt/codex-home'].join('\n'),
      '.claude.json': onboarded
    })
    const report = await scanHiddenState(deps(home))
    expect(report.findings.map((finding) => finding.name).sort()).toEqual(['CODEX_HOME', 'NO_PROXY', 'https_proxy'])
    expect(named(report, 'https_proxy')).toMatchObject({ cleanable: true, affects: ['codex', 'claude', 'hermes'] })
    expect(named(report, 'CODEX_HOME')).toMatchObject({ cleanable: false, severity: 'info', affects: ['codex'] })
    expect(named(report, 'CODEX_HOME')?.suggestion).toContain('跟着这个目录')
  })

  it('fish 的配置也扫得到', async () => {
    const home = await temporaryHome({ '.config/fish/config.fish': 'set -gx GLM_BASE_URL https://open.bigmodel.invalid/api', '.claude.json': onboarded })
    const report = await scanHiddenState(deps(home))
    expect(named(report, 'GLM_BASE_URL')).toMatchObject({ kind: 'shell_export', affects: ['hermes'], line: 1 })
  })
})

describe('隐形状态 · 值怎么显示（09-13 验收定：只盖密钥）', () => {
  it('名字里带 KEY/TOKEN/SECRET/PASSWORD/AUTH 的才盖，路径与地址原样显示', () => {
    expect(['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'MY_SECRET', 'DB_PASSWORD'].map(shouldMask)).toEqual([true, true, true, true])
    expect(['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NO_PROXY', 'ANTHROPIC_BASE_URL'].map(shouldMask)).toEqual([false, false, false, false])
    // 客户看不懂 /opt••••home 就判断不了要不要停用。
    expect(displayValue('CODEX_HOME', '/opt/codex-home')).toBe('/opt/codex-home')
    expect(displayValue('NO_PROXY', 'localhost,127.0.0.1')).toBe('localhost,127.0.0.1')
    expect(displayValue('ANTHROPIC_AUTH_TOKEN', 'sk-ant-0123456789abcdef')).toBe('sk-a••••cdef')
  })

  it('地址里内嵌的账号密码照样抹掉，⛔ 因为名字里没有 KEY 就整条显示', () => {
    expect(redactCredentials('http://alice:hunter2@proxy.example:7890')).toBe('http://••••@proxy.example:7890')
    expect(displayValue('HTTPS_PROXY', 'http://alice:hunter2@proxy.example:7890')).not.toContain('hunter2')
    expect(redactCredentials('x'.repeat(200))).toHaveLength(161)
  })

  it('扫出来的报告按这个规则走', async () => {
    const home = await temporaryHome({
      '.zshrc': ['export CODEX_HOME=/opt/codex-home', 'export ANTHROPIC_AUTH_TOKEN=sk-ant-0123456789abcdef',
        'export HTTPS_PROXY=http://alice:hunter2@proxy.example:7890'].join('\n'),
      '.claude.json': onboarded
    })
    const report = await scanHiddenState(deps(home))
    expect(named(report, 'CODEX_HOME')?.valueMasked).toBe('/opt/codex-home')
    expect(named(report, 'ANTHROPIC_AUTH_TOKEN')?.valueMasked).toBe('sk-a••••cdef')
    expect(JSON.stringify(report)).not.toContain('hunter2')
    expect(JSON.stringify(report)).not.toContain('0123456789abcdef')
  })
})

describe('隐形状态 · 软链的启动文件（dotfiles 常态）', () => {
  it('链到家目录之下的普通文件＝照常扫，并记下真正的那个文件', async () => {
    const home = await temporaryHome({ 'dotfiles/bashrc': 'export OPENAI_API_KEY=sk-openai-0123456789abcdef\n', '.claude.json': onboarded })
    await symlink(join(home, 'dotfiles', 'bashrc'), join(home, '.bashrc'))
    const report = await scanHiddenState(deps(home))
    const finding = named(report, 'OPENAI_API_KEY')
    // 客户看到的是 ~/.bashrc，真正要改的是 dotfiles/bashrc——两个都得有。
    expect(finding?.source).toBe(join(home, '.bashrc'))
    expect(finding?.resolvedSource).toContain('dotfiles/bashrc')
    expect(report.unreadable).toEqual([])
  })

  it('链到家目录以外＝**⛔ 静默跳过**，记一条说清楚为什么没查', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    const outside = await temporaryHome({ 'bashrc': 'export OPENAI_API_KEY=sk-openai-0123456789abcdef\n' })
    await symlink(join(outside, 'bashrc'), join(home, '.bashrc'))
    const report = await scanHiddenState(deps(home))
    expect(report.findings).toEqual([])
    expect(report.unreadable).toHaveLength(1)
    expect(report.unreadable[0].source).toBe(join(home, '.bashrc'))
    expect(report.unreadable[0].reason).toContain('指向家目录以外')
  })

  it('链断了也照实说，⛔ 当成「没有这个文件」', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    await symlink(join(home, '不存在的文件'), join(home, '.zshrc'))
    const report = await scanHiddenState(deps(home))
    expect(report.unreadable[0]).toMatchObject({ source: join(home, '.zshrc'), reason: '是链接文件，指向的目标不在了，未检查' })
  })

  it('.claude.json 软链走也是同一套判法', async () => {
    const home = await temporaryHome({ 'dotfiles/claude.json': JSON.stringify({ hasCompletedOnboarding: false }) })
    await symlink(join(home, 'dotfiles', 'claude.json'), join(home, '.claude.json'))
    const report = await scanHiddenState(deps(home))
    expect(named(report, 'hasCompletedOnboarding')?.resolvedSource).toContain('dotfiles/claude.json')
  })
})

describe('隐形状态 · Windows 注册表里的环境变量', () => {
  const userOutput = [
    '', 'HKEY_CURRENT_USER\\Environment', '    ANTHROPIC_API_KEY    REG_SZ    sk-ant-0123456789abcdef',
    '    Path    REG_EXPAND_SZ    C:\\Users\\demo\\AppData\\Roaming\\npm', '    CODEX_HOME    REG_SZ    C:\\Users\\demo\\codex home', ''
  ].join('\r\n')

  it('reg query 的三列解析得出来，值里带空格也不截断', () => {
    expect(parseRegistryQuery(userOutput)).toEqual([
      { name: 'ANTHROPIC_API_KEY', type: 'REG_SZ', value: 'sk-ant-0123456789abcdef' },
      { name: 'Path', type: 'REG_EXPAND_SZ', value: 'C:\\Users\\demo\\AppData\\Roaming\\npm' },
      { name: 'CODEX_HOME', type: 'REG_SZ', value: 'C:\\Users\\demo\\codex home' }
    ])
  })

  it('win32 上两个键都查，名单外的 Path 不报，读不到的键记一条 unreadable ⛔ 整份报错', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    const report = await scanHiddenState(deps(home, {
      platform: 'win32',
      exec: async (_command, args) => {
        if (args[1] === 'HKCU\\Environment') return userOutput
        if (args[1] === 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings') return '    ProxyEnable    REG_DWORD    0x0'
        if (args[0] === 'winhttp') return 'Current WinHTTP proxy settings:\r\n\r\n    Direct Access (no proxy server).'
        throw Object.assign(new Error('拒绝访问'), { code: 'EACCES' })
      }
    }))
    expect(report.findings.map((finding) => finding.name)).toEqual(['ANTHROPIC_API_KEY', 'CODEX_HOME'])
    expect(named(report, 'ANTHROPIC_API_KEY')).toMatchObject({ kind: 'registry_env', scope: 'user', source: 'HKCU\\Environment', valueMasked: 'sk-a••••cdef' })
    expect(report.unreadable).toEqual([{ source: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', reason: '没有读取权限' }])
  })

  it('mac 上不查注册表', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    let called = false
    const report = await scanHiddenState(deps(home, { exec: async () => { called = true; return '' } }))
    expect(called).toBe(false)
    expect(report.findings).toEqual([])
  })
})

describe('隐形状态 · 残留的系统代理', () => {
  const scutil = (host: string, port: string, enable = '1'): string =>
    ['<dictionary> {', `  HTTPEnable : ${enable}`, `  HTTPPort : ${port}`, `  HTTPProxy : ${host}`,
      `  HTTPSEnable : ${enable}`, `  HTTPSPort : ${port}`, `  HTTPSProxy : ${host}`, '}'].join('\n')

  it('scutil 与 Windows 注册表两种形状都解析得出来', () => {
    expect(parseScutilProxy(scutil('127.0.0.1', '7890'))).toMatchObject({ enabled: true, host: '127.0.0.1', port: 7890 })
    expect(parseScutilProxy(scutil('127.0.0.1', '7890', '0'))).toBeNull()
    expect(parseWindowsProxy('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890'))
      .toMatchObject({ enabled: true, host: '127.0.0.1', port: 7890 })
    expect(parseWindowsProxy('    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890')).toBeNull()
    expect(isLoopback('LocalHost')).toBe(true)
    expect(isLoopback('10.0.0.2')).toBe(false)
  })

  // 第 3 轮补回：老模块（55288a0）查的五处里，这里原来只认 HTTP/HTTPS 和 ProxyEnable/ProxyServer。
  // 公司里用 PAC 上网的客户最容易连不上，扫描却说「本机没有残留」——清单第 5 条的承诺落空。
  it('只开 PAC 也检得出来（mac 的 ProxyAutoConfigEnable、Windows 的 AutoConfigURL）', () => {
    const macPac = ['<dictionary> {', '  ProxyAutoConfigEnable : 1', '  ProxyAutoConfigURLString : http://pac.corp.example/wpad.dat', '}'].join('\n')
    expect(parseScutilProxy(macPac)).toMatchObject({ enabled: true, mode: 'pac', raw: 'PAC: http://pac.corp.example/wpad.dat' })
    expect(parseWindowsProxy('    ProxyEnable    REG_DWORD    0x0\r\n    AutoConfigURL    REG_SZ    http://pac.corp.example/wpad.dat'))
      .toMatchObject({ enabled: true, mode: 'pac', raw: 'PAC: http://pac.corp.example/wpad.dat' })
  })

  it('只开 SOCKS 也检得出来，AutoDetect 开着也检得出来', () => {
    const macSocks = ['<dictionary> {', '  SOCKSEnable : 1', '  SOCKSProxy : 127.0.0.1', '  SOCKSPort : 7891', '}'].join('\n')
    expect(parseScutilProxy(macSocks)).toMatchObject({ enabled: true, host: '127.0.0.1', port: 7891 })
    expect(parseWindowsProxy('    ProxyEnable    REG_DWORD    0x0\r\n    AutoDetect    REG_DWORD    0x1'))
      .toMatchObject({ enabled: true, mode: 'pac' })
  })

  it('netsh winhttp 的系统级代理检得出来，Direct access 算没有', () => {
    const direct = ['Current WinHTTP proxy settings:', '', '    Direct Access (no proxy server).'].join('\r\n')
    const configured = ['Current WinHTTP proxy settings:', '', '    Proxy Server(s) :  127.0.0.1:8888', '    Bypass List     :  (none)'].join('\r\n')
    expect(parseWindowsWinHttpProxy(direct)).toBeNull()
    expect(parseWindowsWinHttpProxy(configured)).toMatchObject({ enabled: true, host: '127.0.0.1', port: 8888, mode: 'winhttp' })
  })

  it('只开 PAC 时按清单第 5 条只报告：不判残留、⛔ 清理', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    const pac = ['<dictionary> {', '  ProxyAutoConfigEnable : 1', '  ProxyAutoConfigURLString : http://pac.corp.example/wpad.dat', '}'].join('\n')
    let probed = false
    const report = await scanHiddenState(deps(home, {
      readSystemProxy: undefined, exec: async () => pac,
      isPortListening: async () => { probed = true; return false }
    }))
    expect(probed).toBe(false)
    const finding = named(report, '系统代理')
    expect(finding).toMatchObject({ kind: 'system_proxy', severity: 'info', cleanable: false })
    expect(finding?.impact).toContain('PAC')
    expect(finding?.valueMasked).toContain('pac.corp.example')
  })

  it('SOCKS 指向本机死端口＝和 HTTP 一样算残留', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    const socks = ['<dictionary> {', '  SOCKSEnable : 1', '  SOCKSProxy : 127.0.0.1', '  SOCKSPort : 7891', '}'].join('\n')
    const report = await scanHiddenState(deps(home, {
      readSystemProxy: undefined, exec: async () => socks, isPortListening: async () => false
    }))
    expect(named(report, '系统代理')).toMatchObject({ severity: 'blocking', cleanable: false })
  })

  it('win32 上注册表和 WinHTTP 两处都查：注册表没开时 WinHTTP 配了的也报出来', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    const report = await scanHiddenState(deps(home, {
      platform: 'win32', readSystemProxy: undefined, isPortListening: async () => false,
      exec: async (_command, args) => args[0] === 'winhttp'
        ? 'Current WinHTTP proxy settings:\r\n\r\n    Proxy Server(s) :  127.0.0.1:8888\r\n    Bypass List     :  (none)'
        : '    ProxyEnable    REG_DWORD    0x0'
    }))
    expect(named(report, '系统代理')).toMatchObject({ severity: 'info', cleanable: false })
    expect(JSON.stringify(report)).toContain('8888')
  })

  it('win32 上两处代理设置都读不到时记 unreadable，⛔ 当成「本机没有残留」', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    const report = await scanHiddenState(deps(home, {
      platform: 'win32', readSystemProxy: undefined,
      exec: async () => { throw Object.assign(new Error('拒绝访问'), { code: 'EACCES' }) }
    }))
    expect(report.findings).toEqual([])
    expect(report.unreadable).toContainEqual({ source: '系统代理设置', reason: '没有读取权限' })
  })

  it('指向本机、端口没人听＝残留，报 blocking 且只报告不处理', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    const report = await scanHiddenState(deps(home, {
      readSystemProxy: undefined, exec: async () => scutil('127.0.0.1', '7890'), isPortListening: async () => false
    }))
    expect(named(report, '系统代理')).toMatchObject({ kind: 'system_proxy', severity: 'blocking', cleanable: false })
    expect(named(report, '系统代理')?.impact).toContain('7890')
    expect(named(report, '系统代理')?.suggestion).toContain('网络')
  })

  it('端口有人在听就不是残留', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    const report = await scanHiddenState(deps(home, {
      readSystemProxy: undefined, exec: async () => scutil('127.0.0.1', '7890'), isPortListening: async () => true
    }))
    expect(named(report, '系统代理')).toMatchObject({ severity: 'info' })
  })

  it('指向别的地址只报「有代理」，**⛔ 判成残留**', async () => {
    const home = await temporaryHome({ '.claude.json': onboarded })
    let probed = false
    const report = await scanHiddenState(deps(home, {
      readSystemProxy: undefined, exec: async () => scutil('proxy.corp.example', '8080'),
      isPortListening: async () => { probed = true; return false }
    }))
    expect(probed).toBe(false)
    expect(named(report, '系统代理')).toMatchObject({ severity: 'info' })
    expect(named(report, '系统代理')?.impact).not.toContain('没清干净')
  })
})

describe('隐形状态 · Claude 的引导标记', () => {
  it('没写过就报；写过了不报', async () => {
    const missing = await scanHiddenState(deps(await temporaryHome()))
    expect(named(missing, 'hasCompletedOnboarding')).toMatchObject({ severity: 'blocking', cleanable: true, affects: ['claude'] })
    const done = await scanHiddenState(deps(await temporaryHome({ '.claude.json': JSON.stringify({ hasCompletedOnboarding: true }) })))
    expect(done.findings).toEqual([])
  })

  it('拒绝过的 Key 只报个数，⛔ 把 Key 本身带出来', async () => {
    const home = await temporaryHome({
      '.claude.json': JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { rejected: ['sk-secret-one', 'sk-secret-two'] } })
    })
    const report = await scanHiddenState(deps(home))
    const finding = named(report, 'customApiKeyResponses.rejected')
    expect(finding).toMatchObject({ valueMasked: '2 条', cleanable: false, severity: 'warning' })
    expect(JSON.stringify(report)).not.toContain('sk-secret-one')
  })

  it('CLAUDE_CONFIG_DIR 一设就跟着搬家，⛔ 写死 ~/.claude.json', async () => {
    const home = await temporaryHome()
    const elsewhere = await temporaryHome({ '.claude.json': JSON.stringify({ hasCompletedOnboarding: true }) })
    expect(claudeConfigPath(home, { CLAUDE_CONFIG_DIR: elsewhere })).toBe(join(elsewhere, '.claude.json'))
    const report = await scanHiddenState(deps(home, { env: { CLAUDE_CONFIG_DIR: elsewhere } }))
    expect(named(report, 'hasCompletedOnboarding')).toBeUndefined()
  })

  it('内容坏掉只记 unreadable，⛔ 让整份报告抛错', async () => {
    const home = await temporaryHome({ '.claude.json': '{ 这不是 JSON', '.zshrc': 'export ANTHROPIC_AUTH_TOKEN=sk-ant-0123456789abcdef' })
    const report = await scanHiddenState(deps(home))
    expect(report.unreadable.map((item) => item.source)).toEqual([join(home, '.claude.json')])
    expect(report.findings.map((finding) => finding.name)).toEqual(['ANTHROPIC_AUTH_TOKEN'])
  })
})

describe('隐形状态 · NO_PROXY 不是代理（第 3 轮：方向别再反）', () => {
  it('NO_PROXY 判成不可清理的 info，HTTP_PROXY 仍判可清理——两个方向都要断', () => {
    const noProxy = classifyName('NO_PROXY')
    expect(noProxy).not.toBeNull()
    expect(noProxy!.cleanable).toBe(false)
    expect(noProxy!.severity).toBe('info')
    // 小写一样认（classifyName 会归一成大写）。
    expect(classifyName('no_proxy')?.cleanable).toBe(false)
    // 只断一个方向的等于没断：真代理必须仍然可清理。
    expect(classifyName('HTTP_PROXY')?.cleanable).toBe(true)
    expect(classifyName('HTTPS_PROXY')?.cleanable).toBe(true)
    expect(classifyName('ALL_PROXY')?.cleanable).toBe(true)
  })

  it('提示语说清 NO_PROXY 真实身份：豁免名单，本机网关靠它', () => {
    const noProxy = classifyName('NO_PROXY')!
    expect(noProxy.impact).toContain('白名单')
    expect(noProxy.impact).toContain('本机网关')
    expect(noProxy.suggestion).toContain('保留')
  })

  it('扫描结果里 NO_PROXY 不可清理，停用名单里不会带上它', async () => {
    const home = await temporaryHome({
      '.zshrc': ['export NO_PROXY=localhost,127.0.0.1', 'export HTTPS_PROXY=http://127.0.0.1:7890'].join('\n'),
      '.claude.json': onboarded
    })
    const report = await scanHiddenState(deps(home))
    expect(named(report, 'NO_PROXY')).toMatchObject({ cleanable: false, severity: 'info' })
    expect(named(report, 'HTTPS_PROXY')).toMatchObject({ cleanable: true })
    expect(report.findings.filter((finding) => finding.cleanable).map((finding) => finding.name)).toEqual(['HTTPS_PROXY'])
  })
})

describe('隐形状态 · 判据', () => {
  it('一条都没有时返回空报告，⛔ 报「未知」', async () => {
    const home = await temporaryHome({ '.claude.json': JSON.stringify({ hasCompletedOnboarding: true }) })
    const report = await scanHiddenState(deps(home))
    expect(report).toMatchObject({ findings: [], unreadable: [], platform: 'darwin' })
    expect(report.scannedAt).toBe('2026-09-13T11:00:00.000Z')
  })

  it('四类残留各造一处，一次全扫得出来', async () => {
    const home = await temporaryHome({
      '.zshrc': 'export OPENAI_API_KEY=sk-openai-0123456789abcdef',
      '.claude.json': JSON.stringify({ hasCompletedOnboarding: false })
    })
    const report = await scanHiddenState(deps(home, {
      platform: 'win32', readSystemProxy: async () => ({ enabled: true, host: '127.0.0.1', port: 7890, raw: '127.0.0.1:7890' }),
      isPortListening: async () => false,
      exec: async (_command, args) => args[1] === 'HKCU\\Environment' ? '    KIMI_API_KEY    REG_SZ    sk-kimi-0123456789abcdef' : ''
    }))
    expect([...new Set(report.findings.map((finding) => finding.kind))].sort())
      .toEqual(['claude_onboarding', 'registry_env', 'shell_export', 'system_proxy'])
    expect(report.unreadable).toEqual([])
  })
})
