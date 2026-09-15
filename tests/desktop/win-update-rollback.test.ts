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
