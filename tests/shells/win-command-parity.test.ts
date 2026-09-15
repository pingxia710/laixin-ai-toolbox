// 0.4.10 包一二补 · 命令 token 的转义写法与 cross-spawn 逐字对齐。
//
// 一补里命令文件本身被写成 ^"C:\Program Files\…\npm.cmd^"(引号也 ^ 转义)。验收方查到两家
// cmd 解析资料对此打架:dbenham 那套规则下 ^" 是「字面引号且不进入引号态」,于是路径里的空格
// 会把 token 切断;Wine 的实现下又是正常的。本机无 Windows,裁决不了。
//
// 裁决办法不是再找一份资料,是照抄一份**经过海量真机验证**的实现:cross-spawn 7.0.6——
// npm / yarn / 大量 CLI 在真 Windows 上跑 .cmd 全靠它,C:\Program Files\nodejs\npm.cmd
// 这种带空格路径正是它每天在跑的。它的做法是:命令 token **只 ^ 转义元字符、⛔ 加引号**
// (空格本身就在元字符表里,转义成 ^ 空格就不会切断 token);参数才双引号包裹。
//
// ⛔ 直接 import cross-spawn 进主进程:它还带 shebang 探测、PATH 解析等我们不需要的行为。
//
// 期望值是 cross-spawn 7.0.6 的实测输出,**固化在本文件里**:它在本仓是间接依赖
// (eslint / vite 等带进来的,不在 package.json),哪天它消失或升到转义算法不同的大版本,
// 固化值仍然钉得住我们的实现;装着它的时候再顺带比一次逐字相等,两头都不落空。
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { escapeCommandToken, escapeArgumentToken } from '../../app/main/shells/win-command'

/** 验收方给的 13 个形态:真实安装命令里会出现的,加上 cmd 的全部危险字符。 */
const CASES: readonly { input: string; command: string; argument: string; argumentDouble: string }[] = [
  { input: "C:\\Program Files\\nodejs\\npm.cmd", command: "C:\\Program^ Files\\nodejs\\npm.cmd", argument: "^\"C:\\Program^ Files\\nodejs\\npm.cmd^\"", argumentDouble: "^^^\"C:\\Program^^^ Files\\nodejs\\npm.cmd^^^\"" },
  { input: "a&b", command: "a^&b", argument: "^\"a^&b^\"", argumentDouble: "^^^\"a^^^&b^^^\"" },
  { input: "a^b", command: "a^^b", argument: "^\"a^^b^\"", argumentDouble: "^^^\"a^^^^b^^^\"" },
  { input: "%PATH%", command: "^%PATH^%", argument: "^\"^%PATH^%^\"", argumentDouble: "^^^\"^^^%PATH^^^%^^^\"" },
  { input: "say \"hi\"", command: "say^ ^\"hi^\"", argument: "^\"say^ \\^\"hi\\^\"^\"", argumentDouble: "^^^\"say^^^ \\^^^\"hi\\^^^\"^^^\"" },
  { input: "C:\\dir\\", command: "C:\\dir\\", argument: "^\"C:\\dir\\\\^\"", argumentDouble: "^^^\"C:\\dir\\\\^^^\"" },
  { input: "@openai/codex", command: "@openai/codex", argument: "^\"@openai/codex^\"", argumentDouble: "^^^\"@openai/codex^^^\"" },
  { input: "a|b>c<d(e)f", command: "a^|b^>c^<d^(e^)f", argument: "^\"a^|b^>c^<d^(e^)f^\"", argumentDouble: "^^^\"a^^^|b^^^>c^^^<d^^^(e^^^)f^^^\"" },
  { input: "bang!", command: "bang^!", argument: "^\"bang^!^\"", argumentDouble: "^^^\"bang^^^!^^^\"" },
  { input: "中文路径\\工具箱.cmd", command: "中文路径\\工具箱.cmd", argument: "^\"中文路径\\工具箱.cmd^\"", argumentDouble: "^^^\"中文路径\\工具箱.cmd^^^\"" },
  { input: "", command: "", argument: "^\"^\"", argumentDouble: "^^^\"^^^\"" },
  { input: "install", command: "install", argument: "^\"install^\"", argumentDouble: "^^^\"install^^^\"" },
  { input: "C:\\Users\\a b\\AppData\\Roaming\\npm\\codex.cmd", command: "C:\\Users\\a^ b\\AppData\\Roaming\\npm\\codex.cmd", argument: "^\"C:\\Users\\a^ b\\AppData\\Roaming\\npm\\codex.cmd^\"", argumentDouble: "^^^\"C:\\Users\\a^^^ b\\AppData\\Roaming\\npm\\codex.cmd^^^\"" }
]

describe('二补 · 转义与 cross-spawn 7.0.6 逐字相等', () => {
  it.each(CASES.map((item) => [JSON.stringify(item.input), item] as const))(
    '命令 token %s 只 ^ 转义元字符、⛔ 加引号', (_label, item) => {
      expect(escapeCommandToken(item.input)).toBe(item.command)
    })

  it.each(CASES.map((item) => [JSON.stringify(item.input), item] as const))(
    '参数 token %s 双引号包裹后再 ^ 转义', (_label, item) => {
      expect(escapeArgumentToken(item.input)).toBe(item.argument)
    })

  it('cmd-shim 的双重转义也一致(node_modules/.bin 下的 .cmd 会被 cmd 解析两轮)', () => {
    for (const item of CASES) expect(escapeArgumentToken(item.input, true)).toBe(item.argumentDouble)
  })

  it('命令 token ⛔ 被引号包住:空格靠 ^ 转义,加引号会在 dbenham 规则下切断 token', () => {
    const escaped = escapeCommandToken('C:\\Program Files\\nodejs\\npm.cmd')
    expect(escaped.startsWith('"')).toBe(false)
    expect(escaped).not.toContain('^"')
    expect(escaped).toBe('C:\\Program^ Files\\nodejs\\npm.cmd')
  })

  // 装着 cross-spawn 时再直接比一次:固化值万一抄错,这里会红。
  it('与本机 node_modules 里的 cross-spawn 直接比对(没装就跳过)', () => {
    const load = createRequire(import.meta.url)
    let reference: { command: (a: string) => string; argument: (a: string, d?: boolean) => string } | undefined
    try { reference = load('cross-spawn/lib/util/escape.js') } catch { reference = undefined }
    if (!reference) return
    for (const item of CASES) {
      expect(escapeCommandToken(item.input)).toBe(reference.command(item.input))
      expect(escapeArgumentToken(item.input)).toBe(reference.argument(item.input))
      expect(escapeArgumentToken(item.input, true)).toBe(reference.argument(item.input, true))
    }
  })
})
