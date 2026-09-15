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
    expect(xml).toContain('<Command>C:\\Windows\\System32\\cmd.exe</Command>')
    expect(xml).toContain('<Arguments>/d /s /c &quot;')
    // env 在包装里逐字可见(少一把放行钥匙守护就写不了系统设置,真机第二层护栏就是这样拦的)
    expect(xml).toContain('set &quot;ELECTRON_RUN_AS_NODE=1&quot;&amp;&amp;')
    expect(xml).toContain('set &quot;TOOLBOX_REAL_NETWORK_ADAPTER=1&quot;')
    // 守护命令在 set 之后、整体引号内;exe 路径带空格时按 Windows 规矩加引号
    expect(xml).toContain('set &quot;ELECTRON_RUN_AS_NODE=1&quot;')
    expect(xml.indexOf('set &quot;ELECTRON_RUN_AS_NODE=1&quot;')).toBeLessThan(xml.indexOf('tunnel-daemon.mjs'))
    expect(xml).toContain('--task-path \\Laixin\\cn.laixin.toolbox.tunnel')
    expect(xml).toContain('&quot;C:\\Program Files\\laixin\\来信AI工具箱统一版.exe&quot;')
    // 守护输出有落点(常驻没有父进程接管 stdio)
    expect(xml).toContain('&gt;&gt; &quot;C:\\Users\\s\\AppData\\Roaming\\来信AI工具箱统一版\\logs\\tunnel-daemon.log&quot; 2&gt;&amp;1')
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\s\\AppData\\Roaming\\来信AI工具箱统一版\\logs</WorkingDirectory>')
  })
})
