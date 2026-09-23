// 守护常驻的描述文件（macOS LaunchAgent / Windows 计划任务）：三条硬边界要能在文件里逐字看见。
// Windows 侧的形状由 2026-09-14 真机复现台钉死(根文件夹拒绝、XML 带不了 env、RestartOnFailure 不重启)。
import { describe, expect, it } from 'vitest'
import { RESIDENT_LABEL, RESIDENT_TASK, RESIDENT_TASK_LEGACY, macAgentPath, macAgentPlist, winTaskXml } from '../../app/main/tunnel/platform/resident'

const spec = {
  executable: '/Applications/来信AI工具箱统一版.app/Contents/MacOS/来信AI工具箱统一版',
  args: ['/Applications/来信AI工具箱统一版.app/Contents/Resources/sidecar/mac/tunnel-daemon.mjs', 'start', '--data-dir', '/Users/someone/Library/Application Support/来信AI工具箱统一版/tunnel'],
  env: { ELECTRON_RUN_AS_NODE: '1', TOOLBOX_REAL_NETWORK_ADAPTER: '1' },
  logDir: '/Users/someone/Library/Logs/来信AI工具箱统一版'
}

describe('macOS 守护常驻描述文件', () => {
  it('正常退出不许被拉起，非正常退出才拉起（客户点断开后 ⛔ 复活）', () => {
    const plist = macAgentPlist(spec)
    // KeepAlive 必须是「只在非正常退出时拉起」，⛔ 写成无条件的 <true/>
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/)
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
  })

  it('开机即随登录起来，后台优先级，日志有落点', () => {
    const plist = macAgentPlist(spec)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toContain('<string>Background</string>')
    expect(plist).toContain('tunnel-daemon.log')
  })

  it('可执行文件、参数、环境变量原样带上（少一个放行钥匙守护就写不了系统设置）', () => {
    const plist = macAgentPlist(spec)
    expect(plist).toContain(spec.executable)
    for (const arg of spec.args) expect(plist).toContain(arg)
    expect(plist).toContain('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>')
    expect(plist).toContain('<key>TOOLBOX_REAL_NETWORK_ADAPTER</key><string>1</string>')
  })

  it('路径里的中文与 XML 特殊字符不会把描述文件弄坏', () => {
    const plist = macAgentPlist({ ...spec, logDir: '/tmp/a&b<c>"d\'e' })
    expect(plist).toContain('/tmp/a&amp;b&lt;c&gt;&quot;d&apos;e')
    expect(plist).not.toMatch(/[^&]&(?!(amp|lt|gt|quot|apos);)/)
    expect(plist).toContain('来信AI工具箱统一版')
  })

  it('装在每用户目录，⛔ 系统级目录（那要管理员权限）', () => {
    expect(macAgentPath()).toContain('/Library/LaunchAgents/')
    expect(macAgentPath()).not.toMatch(/^\/Library\/LaunchDaemons/)
    expect(macAgentPath()).toContain(RESIDENT_LABEL)
  })
})

describe('Windows 守护常驻任务定义（2026-09-14 真机复现台定形）', () => {
  it('任务住 \\Laixin\\ 子文件夹:根文件夹非提升建不了(真机 Access denied),子文件夹可建(真机实测)', () => {
    expect(RESIDENT_TASK).toBe(`\\Laixin\\${RESIDENT_LABEL}`)
    expect(RESIDENT_TASK_LEGACY).toBe(RESIDENT_LABEL)
    expect(winTaskXml(spec)).toContain('来信AI工具箱网络守护')
  })

  it('触发器只有 TimeTrigger+Repetition(LogonTrigger 非提升被这代 Windows 拒绝,真机实测)+保活、最低权限、⛔ 管理员', () => {
    const xml = winTaskXml(spec)
    expect(xml).not.toContain('<LogonTrigger>')
    expect(xml).toMatch(/<TimeTrigger>\s*<Repetition>\s*<Interval>PT1M<\/Interval>\s*<StopAtDurationEnd>false<\/StopAtDurationEnd>\s*<\/Repetition>/)
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>\s*<\/RestartOnFailure>/)
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).not.toContain('HighestAvailable')
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>')
    // 重入空转靠「同刻只跑一个」:守护活着时(常驻形态守护驻留不退),后续触发被忽略
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
  })

  // 名字要能被搜到:将来有人动 Command,搜「conhost」或「黑窗口」就该命中这条。
  // ⛔ 把它挂在别的用例里 —— 那样它红起来时下一个人不知道自己碰了什么(2026-09-16 验收意见)。
  it('Windows 侧 Command 必须是 conhost --headless,⛔ 直接调 cmd.exe(否则客户桌面上常驻一个黑窗口)', async () => {
    const { residentSpecFor } = await import('../../app/main/tunnel/resident-bridge')
    const spec = residentSpecFor({
      executable: 'C:\\Program Files\\laixin\\来信AI工具箱统一版.exe',
      launch: {
        daemonPath: 'C:\\res\\sidecar\\win\\tunnel-daemon.mjs', adapterPath: 'C:\\res\\sidecar\\win\\managed-adapter.mjs',
        env: { ELECTRON_RUN_AS_NODE: '1' }
      },
      dataDir: 'C:\\data', logDir: 'C:\\logs', taskPath: '\\Laixin\\cn.laixin.toolbox.tunnel'
    })
    const xml = winTaskXml(spec)
    // 任务以 InteractiveToken 跑(非提升建不了 LogonTrigger),交互身份启动控制台程序窗口会显示给客户;
    // 守护一直跑,cmd 就一直等着它 —— 不是闪一下,是一直杵在桌面上(2026-09-16 创始人真机撞见)。
    // Settings 里的 <Hidden>true</Hidden> 管不着:它只让任务在「任务计划程序」列表里不显示。
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>')
    expect(xml).toContain('<Arguments>--headless C:\\Windows\\System32\\cmd.exe /d /v:off /s /c &quot;')
    // 防回退:改回直接调 cmd.exe 黑窗口就回来,而这在代码评审里看不出来
    expect(xml).not.toContain('<Command>C:\\Windows\\System32\\cmd.exe</Command>')
    // 正向证据:上面那条「不该出现」只有在确实产出了 Command 节点时才成立
    expect(xml).toMatch(/<Command>[^<]+<\/Command>/)
  })

  it('守护的启动参数带 --task-path(干净收尾后自禁任务用);mac 侧不带', async () => {
    const { residentSpecFor } = await import('../../app/main/tunnel/resident-bridge')
    const winSpec = residentSpecFor({
      executable: 'C:\\Program Files\\laixin\\来信AI工具箱统一版.exe',
      launch: {
        daemonPath: 'C:\\res\\sidecar\\win\\tunnel-daemon.mjs', adapterPath: 'C:\\res\\sidecar\\win\\managed-adapter.mjs',
        env: { ELECTRON_RUN_AS_NODE: '1', TOOLBOX_REAL_NETWORK_ADAPTER: '1', TOOLBOX_REAL_TERMINAL_ENVIRONMENT: '1' }
      },
      dataDir: 'C:\\Users\\s\\AppData\\Roaming\\来信AI工具箱统一版\\tunnel',
      logDir: 'C:\\Users\\s\\AppData\\Roaming\\来信AI工具箱统一版\\logs',
      taskPath: '\\Laixin\\cn.laixin.toolbox.tunnel'
    })
    expect(winSpec.args).toContain('--task-path')
    expect(winSpec.args).toContain('\\Laixin\\cn.laixin.toolbox.tunnel')
    const macSpec = residentSpecFor({
      executable: '/Applications/来信AI工具箱统一版.app/Contents/MacOS/来信AI工具箱统一版',
      launch: { daemonPath: '/res/sidecar/mac/tunnel-daemon.mjs', adapterPath: '/res/sidecar/mac/managed-adapter.mjs', env: {} },
      dataDir: '/tmp/data', logDir: '/tmp/logs'
    })
    expect(macSpec.args).not.toContain('--task-path')
    // 任务 XML 的包装动作里同样把 --task-path 带进守护(自禁连线的另一半)
    const xml = winTaskXml(winSpec)
    // env 在包装里逐字可见(少一把放行钥匙守护就写不了系统设置,真机第二层护栏就是这样拦的)
    expect(xml).toContain('set &quot;ELECTRON_RUN_AS_NODE=1&quot;&amp;&amp;')
    expect(xml).toContain('set &quot;TOOLBOX_REAL_NETWORK_ADAPTER=1&quot;')
    // 守护命令在 set 之后;exe 用 ^ 转义空格，参数则用任务计划实测可执行的普通引号。
    // ⛔ 把 cross-spawn 的 ^&quot; 参数包装塞进任务计划的 conhost→cmd /s 链，任务会报 0 却不启动守护。
    expect(xml).toContain('set &quot;ELECTRON_RUN_AS_NODE=1&quot;')
    expect(xml.indexOf('set &quot;ELECTRON_RUN_AS_NODE=1&quot;')).toBeLessThan(xml.indexOf('tunnel-daemon.mjs'))
    expect(xml).toContain('--task-path \\Laixin\\cn.laixin.toolbox.tunnel')
    expect(xml).toContain('C:\\Program^ Files\\laixin\\来信AI工具箱统一版.exe C:\\res\\sidecar\\win\\tunnel-daemon.mjs')
    // 守护输出有落点(常驻没有父进程接管 stdio)
    expect(xml).toContain('&gt;&gt; C:\\Users\\s\\AppData\\Roaming\\来信AI工具箱统一版\\logs\\tunnel-daemon.log 2&gt;&amp;1')
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\s\\AppData\\Roaming\\来信AI工具箱统一版\\logs</WorkingDirectory>')
  })

  // 2026-09-18 客户故障回归:Windows 用户名带空格(MR WHITE),旧写法把 exe 路径用裸引号包进
  // cmd 包装串,解析层从「MR WHITE」的空格处把命令切开,守护以「logs\WHITE\…统一版.exe」这样的
  // 残片当入口模块,MODULE_NOT_FOUND 每分钟刷屏,tunnel-daemon.log 全是同一条崩溃栈。
  it('用户名带空格的机器守护起得来:exe ^ 转义、参数和日志走任务计划实测可执行的普通引号', () => {
    const xml = winTaskXml({
      executable: 'C:\\Users\\MR WHITE\\AppData\\Local\\Programs\\laixin-ai-toolbox\\来信AI工具箱统一版.exe',
      args: [
        'C:\\Users\\MR WHITE\\AppData\\Local\\Programs\\laixin-ai-toolbox\\resources\\sidecar\\win\\tunnel-daemon.mjs',
        'start', '--data-dir', 'C:\\Users\\MR WHITE\\AppData\\Roaming\\来信AI工具箱统一版', '--resident', '1'
      ],
      env: { ELECTRON_RUN_AS_NODE: '1', TOOLBOX_REAL_NETWORK_ADAPTER: '1' },
      logDir: 'C:\\Users\\MR WHITE\\AppData\\Roaming\\来信AI工具箱统一版\\logs'
    })
    // 命令位的 exe 不带引号:「MR WHITE」的空格转成 ^ ,不再把路径切成 C:\Users\MR + WHITE\…
    expect(xml).toContain('&amp;&amp; C:\\Users\\MR^ WHITE\\AppData\\Local\\Programs\\laixin-ai-toolbox\\来信AI工具箱统一版.exe &quot;C:\\Users\\MR WHITE\\AppData\\Local\\Programs\\laixin-ai-toolbox\\resources\\sidecar\\win\\tunnel-daemon.mjs&quot; start')
    // 带空格的参数(--data-dir 的值)整体一个 token
    expect(xml).toContain('--data-dir &quot;C:\\Users\\MR WHITE\\AppData\\Roaming\\来信AI工具箱统一版&quot;')
    // 日志重定向目标同理(否则 >> 只吃到 C:\Users\MR,日志写进别人的目录)
    expect(xml).toContain('&gt;&gt; &quot;C:\\Users\\MR WHITE\\AppData\\Roaming\\来信AI工具箱统一版\\logs\\tunnel-daemon.log&quot; 2&gt;&amp;1')
    // exe 位不能回到裸引号:那会把「MR WHITE」从命令 token 切开；参数普通引号是任务计划实测形状。
    const argumentsElement = xml.match(/<Arguments>(.*)<\/Arguments>/)?.[1] ?? ''
    expect(argumentsElement).toContain('&amp;&amp; C:\\Users\\MR^ WHITE\\AppData')
    expect(argumentsElement).not.toContain('&amp;&amp; &quot;C:\\Users\\MR WHITE')
    expect(argumentsElement).not.toContain('^&quot;')
  })

  it('路径含 cmd 元字符时不装常驻:嵌套 cmd 引号无法可靠保真，改走主进程直启', () => {
    const metaSpec = {
      executable: 'C:\\Users\\A&B\\laixin toolbox\\toolbox.exe',
      args: ['C:\\Users\\A&B\\daemon ^ test.mjs', '--data-dir', 'C:\\Users\\A&B\\!data!'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      logDir: 'C:\\Users\\A&B\\logs'
    }
    expect(() => winTaskXml(metaSpec)).toThrow('暂不支持路径或启动参数含 CMD 特殊字符')
  })

  it('路径含 % 时拒绝装常驻:⛔ 让 cmd 展开后静默丢失守护', () => {
    expect(() => winTaskXml({
      executable: 'C:\\Users\\%USERPROFILE%\\toolbox.exe',
      args: ['daemon.mjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      logDir: 'C:\\logs'
    })).toThrow('暂不支持路径或启动参数含 %')
  })
})
