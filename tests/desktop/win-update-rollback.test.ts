// 审计 A3(2026-09-12 上线检查):Windows 更新回滚只回滚 app.asar,NSIS /S 却是整目录替换,
// 失败时留下「旧 asar + 新 sidecar/内核/主程序」的混合态——那不是任何一个发过的版本。
// 本机无 Windows 也无 pwsh,脚本无法真跑;这里做源码契约核对,把「整目录备份 + 整目录还原」
// 钉在仓内,⛔ 让它被悄悄改回去。真 Windows 上的执行验证另列(见交付档)。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const script = readFileSync(fileURLToPath(new URL('../../resources/update-helper.ps1', import.meta.url)))
const source = script.toString('utf8').replace(/^\uFEFF/, '')

describe('Windows 更新回滚与 NSIS 整目录替换对称(审计 A3)', () => {
  it('脚本仍是 UTF-8 BOM + CRLF:Windows PowerShell 5.1 据此解码中文提示', () => {
    expect(script.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(source.includes('\r\n')).toBe(true)
  })

  it('覆盖前备份的是整个安装目录,⛔ 只备份 app.asar', () => {
    expect(source).toContain('Copy-Item -LiteralPath $job.target -Destination $backup -Recurse -Force')
    expect(source).not.toContain("Copy-Item -LiteralPath $asar -Destination (Join-Path $backup 'app.asar') -Force")
    // 备份没落全就抛错,此时安装目录还没被动过
    expect(source).toContain('UPDATE_BACKUP_INCOMPLETE')
  })

  it('失败路径把整个安装目录还原回去,⛔ 只把旧 asar 拷回新目录', () => {
    expect(source).toContain('Move-Item -LiteralPath $backup -Destination $job.target -Force')
    expect(source).not.toContain("Copy-Item -LiteralPath (Join-Path $backup 'app.asar') -Destination $asar -Force")
    // 失败目录先挪开再还原:两步都失败时两份副本都留着交人工
    expect(source).toContain('.laixin-update-failed-')
  })

  it('校验失败的包 ⛔ 启动:只有整目录还原成功才拉起旧版,混合态不拉起', () => {
    expect(source).toContain('if ($restored) {')
    expect(source).toContain('if (-not $backupReady -or $restored) {')
    expect(source).not.toContain('if ($null -eq $backup -or $restored) {')
  })
})

// 0.4.10 包一 · 第 4 条:回退备份在「确认新版真的起来了」之前就被删了。
// 原顺序是 删备份 → 启动新版 → 等最多 45s 回执:新版起不来或没回执时,能回退的那份已经没了,
// 客户手上只剩一个打不开的工具箱。mac 侧 update-helper.cjs 是等到回执之后才处理备份,两端本该一致。
// 本机无 Windows 也无 pwsh:这里钉的是行序契约——只断言字符串存在挡不住顺序被改回去。
describe('第 4 条 · 回退备份必须活到新版启动回执之后', () => {
  const lines = source.split(/\r?\n/)
  const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle))
  const ACK_MATCH = '$ack.version -eq $job.version'
  const LAUNCH = 'Start-Process -FilePath $job.executable'
  const DROP_BACKUP = 'Remove-Item -LiteralPath $backup -Recurse -Force'

  it('先启动新版,再等回执:启动在回执比对之前', () => {
    expect(lineOf(LAUNCH)).toBeGreaterThan(0)
    expect(lineOf(LAUNCH)).toBeLessThan(lineOf(ACK_MATCH))
  })

  it('删备份在等回执之后:第一处删备份的行号必须大于回执比对的行号', () => {
    expect(lineOf(DROP_BACKUP)).toBeGreaterThan(lineOf(ACK_MATCH))
  })

  it('无回执/启动失败:走异常分支保住备份,⛔ 写完提示就当无事发生', () => {
    expect(source).toContain('UPDATE_STARTUP_UNCONFIRMED')
    // 超时那条提示必须出现在删备份之前的位置上被跳过——即它不再是 try 块的正常收尾
    expect(lineOf('UPDATE_STARTUP_UNCONFIRMED')).toBeGreaterThan(lineOf(ACK_MATCH))
  })

  it('新版进程还占着安装目录时 ⛔ 强行还原:与 mac 侧 appRunning() 分支对称', () => {
    expect(source).toContain('HasExited')
  })
})

// 2026-09-15 客户实测:连着 AI 网络点「更新并重启」,重启回来还是旧版;Mac 同流程正常。
// 根因:mac 侧助手换 bundle 前有 handOffResident(bootout 等守护真停),Windows 的 ps1 没有——
// 主进程退出只等守护 4 秒,守护停内核/还原代理/自禁任务常常超过 4 秒;助手在守护(主程序当 node
// 跑)和 xray.exe 还活着时 NSIS 覆盖被占用的文件,失败后整目录还原 = 「点了更新又换回旧版」。
// 修复:换文件前先禁常驻任务(每 1 分钟重入,⛔ 让它在换文件窗口里把守护拉回来),再给守护自然
// 收尾的宽限,到点还在才强杀。本机无 Windows/pwsh:照审计 A3 的源码契约做法,把步骤与顺序钉在仓内。
describe('Windows 换文件前先停常驻与隧道进程(与 mac handOffResident 对称)', () => {
  const lines = source.split(/\r?\n/)
  const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle))
  const DISABLE = '/change /tn $task /disable'
  const ENUM = 'Get-CimInstance Win32_Process'
  const KILL = 'Stop-Process -Id $process.ProcessId -Force'
  const BACKUP = 'Copy-Item -LiteralPath $job.target -Destination $backup -Recurse -Force'

  it('先禁常驻任务,且新旧两个任务名(\\Laixin\\<label> 与根路径)都禁', () => {
    expect(lineOf(DISABLE)).toBeGreaterThan(0)
    expect(source).toContain("'\\Laixin\\' + $label")
    // 根路径旧任务名(RESIDENT_TASK_LEGACY)也要禁,否则老机器上的残账照旧重入
    expect(lineOf('$label, $label')).toBeGreaterThan(0)
  })

  it('只清「从安装目录跑起来的」进程:名字限定 + 路径/命令行落在 target 下,⛔ 按名一律杀', () => {
    expect(source).toContain("[IO.Path]::GetFileName($job.executable)")
    expect(source).toContain("'xray.exe'")
    expect(source).toContain('OrdinalIgnoreCase')
    expect(source).toContain('$job.target.ToLowerInvariant()')
  })

  it('顺序钉死:禁任务 → 等待/强杀 → 整目录备份(NSIS 在备份之后)', () => {
    const disable = lineOf(DISABLE)
    const enumeration = lineOf(ENUM)
    const kill = lineOf(KILL)
    const backup = lineOf(BACKUP)
    expect(disable).toBeGreaterThan(0)
    expect(enumeration).toBeGreaterThan(disable)
    expect(kill).toBeGreaterThan(enumeration)
    expect(backup).toBeGreaterThan(kill)
  })

  it('给守护自然收尾的宽限(有界等待),⛔ 一上来就强杀把系统代理留在死端口', () => {
    expect(source).toMatch(/AddSeconds\(\d+\)/)
    // 宽限循环:枚举不到目标进程才跳出,到点才落到强杀那一行
    expect(lineOf('if ($left.Count -eq 0) { break }')).toBeGreaterThan(0)
  })

  it('强杀之后留出句柄释放的间隔再进备份,⛔ 紧贴着 Copy-Item 复制运行中的 exe', () => {
    expect(source).toMatch(/if \(\$left\.Count -gt 0\) \{ Start-Sleep -Milliseconds \d+ \}/)
  })

  // 2026-09-16 验收查出:这一整段停进程的活干在大 try 之外(try 从「校验安装包」才开始),而脚本第 2 行
  // 是 $ErrorActionPreference='Stop'。枚举进程一旦抛错(WMI 库损坏/CIM 服务停用的机器上会),脚本当场
  // 终止、连 result.json 都不写 —— 客户端拿不到任何回执,客户看到的还是「点更新重启又是旧版」,
  // 而且这次连句说明都没有。Windows 真机实测:裸调必抛 CimException 且不生成 result.json;
  // 加 -ErrorAction SilentlyContinue 后不终止、$left 为空立刻 break,退回修复前那条有还原有回执的路。
  it('枚举进程必须自己兜住错误(它在大 try 之外,抛出去就没人写回执)', () => {
    const enumeration = lineOf(ENUM)
    const tryStart = lines.findIndex((line) => line.trim() === 'try {')
    expect(enumeration).toBeGreaterThan(0)
    expect(source).toContain("$ErrorActionPreference = 'Stop'")
    const guarded = lines[enumeration].includes('-ErrorAction SilentlyContinue')
    const insideTry = tryStart >= 0 && enumeration > tryStart
    // 两条路任选其一:要么自带容错,要么整段挪进 try 让 catch 去还原并写回执
    expect(guarded || insideTry).toBe(true)
  })
})

describe('失败回执与 ready 等待(2026-09-16 真机:Administrator 机)', () => {
  it('失败回执必须无 BOM 落盘:PS5.1 的 Set-Content -Encoding UTF8 带 BOM,主进程 JSON.parse 读不出', () => {
    const writeResult = source.indexOf('function Write-Result')
    expect(writeResult).toBeGreaterThan(-1)
    const body = source.slice(writeResult)
    expect(body).toContain('[IO.File]::WriteAllText($job.result')
    expect(body).toContain('UTF8Encoding($false)')
    // ⛔ 退回 Set-Content -Encoding UTF8(带 BOM = 客户端永远读不到上次为什么失败)
    expect(body).not.toContain('Set-Content -LiteralPath $job.result -Encoding UTF8')
  })
})
