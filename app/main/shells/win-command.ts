// Windows 上跑 .cmd / .bat / 无扩展名命令,必须显式经 cmd.exe。
// 两个各自独立的原因,两个都会让 Windows 客户一步也走不下去:
//   1. libuv 的 spawn 只给无扩展名的命令补 .com/.exe。npm 装出来的是 npm.cmd,
//      spawn('npm', …) 在 Windows 上恒 ENOENT —— 工具箱装 Codex / DeepSeek Harness 三源全败。
//   2. 就算给足 .cmd 全路径,Node 24(Electron 44 内置)也会抛 EINVAL:CVE-2024-27980 的修复
//      禁掉了不经 shell 执行批处理文件(src/process_wrap.cc)。
// ⛔ 用 shell: true 裸拼一条字符串:那样参数里的空格和 & | > 会被 cmd 二次解释。
//
// 转义写法**逐字对齐 cross-spawn 7.0.6**(本机 node_modules 里就有,tests/shells/win-command-parity
// 把两边钉成逐字相等)。它是 npm / yarn / 大量 CLI 在真 Windows 上跑 .cmd 所依赖的实现,
// C:\Program Files\nodejs\npm.cmd 这种带空格路径是它每天在跑的形态。两条要害:
//   · **命令 token 只 ^ 转义元字符,⛔ 加引号**——空格本身就在元字符表里(转义成 ^ 空格),
//     所以不需要引号就不会被切断。给命令加 ^" 在 dbenham 那套 cmd 解析规则下是「字面引号且
//     不进入引号态」,路径里的空格反而会把 token 切断(一补就是这么写的,已改)。
//   · 参数才双引号包裹:内部引号按反斜杠规则处理(https://qntm.org/cmd),再整体 ^ 转义元字符。
// ⛔ 直接 import cross-spawn 进主进程:它还带 shebang 探测、PATH 解析等我们不需要的行为。

import { win32 } from 'node:path'

const BATCH_FILE = /\.(cmd|bat)$/i
const POWERSHELL_FILE = /\.ps1$/i
// cross-spawn 的元字符表(含空格),出处 http://www.robvanderwoude.com/escapechars.php
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g
// node_modules/.bin 下的 .cmd 是 cmd-shim:它自己还会再调一次 cmd,^ 转义会被解释两轮。
const CMD_SHIM = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i

/** 命令文件本身:只 ^ 转义元字符,⛔ 加引号。 */
export function escapeCommandToken(file: string): string {
  return file.replace(META_CHARS, '^$1')
}

/** 参数:双引号包裹 + 反斜杠/引号规则 + ^ 转义元字符;cmd-shim 要转义两轮。 */
export function escapeArgumentToken(argument: string, doubleEscapeMetaChars = false): string {
  // 反斜杠序列后跟引号:反斜杠翻倍并转义那个引号。写法照抄 cross-spawn,
  // 它特意用这种形式禁掉 JS 回溯,免得被构造出来的输入卡死(其 PR #160)。
  let value = `${argument}`.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  // 结尾的反斜杠序列(马上要被后面补的引号跟上)同样翻倍
  value = value.replace(/(?=(\\+?)?)\1$/, '$1$1')
  value = `"${value}"`.replace(META_CHARS, '^$1')
  return doubleEscapeMetaChars ? value.replace(META_CHARS, '^$1') : value
}

/** 交给 `cmd.exe /d /s /c` 的那一整个参数(含 /s 会剥掉的最外层引号)。 */
export function commandLineFor(file: string, args: readonly string[]): string {
  // 先把 posix 斜杠归一成 Windows 形态(cross-spawn 同样先 normalize):
  // 配方或调用方给成 C:/foo/bar.cmd 时,不归一会 ENOENT。我们现有的路径都来自 path.join,
  // 本来就是 OS 形态,这一步只是把那个坑提前堵上。
  const normalized = win32.normalize(file)
  const double = CMD_SHIM.test(normalized)
  return `"${[escapeCommandToken(normalized), ...args.map((arg) => escapeArgumentToken(arg, double))].join(' ')}"`
}

/** Windows 上这个可执行文件必须经 cmd.exe 才跑得起来吗? */
export function needsCommandShell(platform: string, file: string): boolean {
  if (platform !== 'win32') return false
  // 无扩展名 ⇒ 交给 cmd 按 PATHEXT 去找(npm → npm.cmd);已带 .exe/.com 的直接跑。
  return BATCH_FILE.test(file) || win32.extname(file) === ''
}

/** cmd.exe 的位置:先认 %SystemRoot%\System32,ComSpec 是可被改写的环境变量,只作退路。 */
function commandShell(env?: NodeJS.ProcessEnv): string {
  const root = env?.SystemRoot ?? env?.systemroot ?? env?.SYSTEMROOT
  return root ? win32.join(root, 'System32', 'cmd.exe') : (env?.ComSpec ?? env?.COMSPEC ?? 'cmd.exe')
}

export interface ResolvedCommand {
  readonly file: string
  readonly args: readonly string[]
  readonly windowsVerbatimArguments?: true
}

/** 把一条 (file, args) 调用改写成这个平台上真正跑得起来的形态;非 Windows 原样返回。 */
export function resolveCommand(platform: string, file: string, args: readonly string[], env?: NodeJS.ProcessEnv): ResolvedCommand {
  if (platform !== 'win32') return { file, args }
  if (POWERSHELL_FILE.test(file)) {
    // .ps1 不是可执行文件,spawn 它必失败;走 powershell 的 -File(⛔ -Command 拼串)。
    return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args] }
  }
  if (!needsCommandShell(platform, file)) return { file, args }
  return { file: commandShell(env), args: ['/d', '/s', '/c', commandLineFor(file, args)], windowsVerbatimArguments: true }
}
