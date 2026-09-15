// 0.4.10 包一 · 第 1、2 条:Windows 上 .cmd 不能直接交给 spawn/execFile。
// libuv 只给无扩展名的命令补 .com/.exe,npm 装出来的是 npm.cmd → ENOENT(安装必败);
// 把 .cmd 直接交给 spawn 在 Node 24(Electron 44 内置)会抛 EINVAL——CVE-2024-27980 的修复
// 禁掉了不经 shell 执行批处理文件。两条合起来:Windows 装不上、版本检测恒空、兼容闸门被绕过。
// 本机无 Windows:这里用 process.platform 打桩 + 模拟 cmd.exe 语义的假可执行文件验证代码路径,
// 真机执行验证另列(见交付档)。
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { spawn as spawnType } from 'node:child_process'
import { defaultRecipes } from '../../app/main/recipes/recipes'
import { ShellInventory } from '../../app/main/shells/inventory'
import { ShellInstaller } from '../../app/main/shells/installer'
import { commandLineFor, needsCommandShell } from '../../app/main/shells/win-command'
import { trustedVersionGateMessage, versionGateMessage } from '../../app/main/actions/ai-access'

/** 记录每次 spawn 的完整调用形态,供断言 argv。 */
function recordingSpawn(exitCode = 0) {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = []
  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => undefined
    setTimeout(() => child.emit('close', exitCode), 5)
    return child
  }) as unknown as typeof spawnType
  return { spawnImpl, calls }
}

const wait = (installer: ShellInstaller) => new Promise<void>((resolve) => {
  const timer = setInterval(() => { if (installer.status().phase !== 'running') { clearInterval(timer); resolve() } }, 5)
})

/** The fixed Hermes venv entry is a generated Python console-script, not a generic shell wrapper. */
function officialHermesConsoleScript(): string {
  return [
    '#!/bin/sh',
    `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python3' "$0" "$@"`,
    "' '''",
    '# -*- coding: utf-8 -*-',
    'import sys',
    'from hermes_cli.main import main',
    'if __name__ == "__main__":',
    '    if sys.argv[0].endswith("-script.pyw"):',
    '        sys.argv[0] = sys.argv[0][:-11]',
    '    elif sys.argv[0].endswith(".exe"):',
    '        sys.argv[0] = sys.argv[0][:-4]',
    '    sys.exit(main())',
    ''
  ].join('\n')
}

async function writeTrustedHermesFixture(root: string, pythonOutput: string): Promise<string> {
  const executable = join(root, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes')
  const python = join(dirname(executable), 'python3')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, officialHermesConsoleScript(), { mode: 0o755 })
  await writeFile(python, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(pythonOutput)}\n`, { mode: 0o755 })
  await chmod(executable, 0o755)
  await chmod(python, 0o755)
  return executable
}

describe('第 1 条 · Windows 安装经 cmd.exe 跑 .cmd', () => {
  it('win32 上 npm 安装的 argv 是 cmd.exe /d /s /c 形态,⛔ 直接 spawn npm', async () => {
    const inv = new ShellInventory({ platform: 'win32', home: 'C:\\Users\\t', env: {}, recipes: () => defaultRecipes,
      exec: async () => 'codex 1.0.0', exists: async () => false })
    const { spawnImpl, calls } = recordingSpawn(0)
    const installer = new ShellInstaller({ platform: 'win32', recipes: () => defaultRecipes, inventory: inv, proxyUrl: () => undefined, spawn: spawnImpl })
    installer.start('codex'); await wait(installer)
    expect(calls[0].command.toLowerCase()).toContain('cmd.exe')
    expect(calls[0].args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(calls[0].options.windowsVerbatimArguments).toBe(true)
    // 命令行里 npm 与参数都在,且整体被一对引号包住(/s 会剥掉这对)
    expect(calls[0].args[3].startsWith('"')).toBe(true)
    expect(calls[0].args[3].endsWith('"')).toBe(true)
    expect(calls[0].args[3]).toContain('npm')
    expect(calls[0].args[3]).toContain('install')
    expect(calls[0].args[3]).toContain('@openai/codex')
  })

  it('darwin 不变:仍然直接 spawn npm,没有 cmd.exe 与 verbatim 标志', async () => {
    const inv = new ShellInventory({ platform: 'darwin', home: '/Users/t', env: {}, recipes: () => defaultRecipes,
      exec: async () => 'codex 1.0.0', exists: async () => false })
    const { spawnImpl, calls } = recordingSpawn(0)
    const installer = new ShellInstaller({ platform: 'darwin', recipes: () => defaultRecipes, inventory: inv, proxyUrl: () => undefined, spawn: spawnImpl })
    installer.start('codex'); await wait(installer)
    expect(calls[0].command).toBe('npm')
    expect(calls[0].args.slice(0, 3)).toEqual(['install', '-g', '@openai/codex'])
    expect(calls[0].options.windowsVerbatimArguments).toBeUndefined()
  })

  it('win32 上已带 .exe 的命令不套 cmd.exe:powershell.exe 直接跑', async () => {
    const inv = new ShellInventory({ platform: 'win32', home: 'C:\\Users\\t', env: {}, recipes: () => defaultRecipes,
      exec: async () => '', exists: async () => false })
    const { spawnImpl, calls } = recordingSpawn(1)
    const installer = new ShellInstaller({ platform: 'win32', recipes: () => defaultRecipes, inventory: inv, proxyUrl: () => undefined, spawn: spawnImpl })
    installer.start('claude-code'); await wait(installer)
    expect(calls[0].command).toBe('powershell.exe')
    expect(calls[0].options.windowsVerbatimArguments).toBeUndefined()
  })

  // 命令 token ⛔ 加引号:空格靠 ^ 转义就够,加引号在 dbenham 那套 cmd 规则下反而会切断 token。
  // 写法与 cross-spawn 7.0.6 逐字对齐,对照见 win-command-parity.test.ts。
  it('含空格的路径过得去:空格 ^ 转义,/s 剥掉最外层后还原成完整路径(命令不带引号)', () => {
    const line = commandLineFor('C:\\Program Files\\nodejs\\npm.cmd', ['install', '-g', '@openai/codex'])
    // cmd /s 剥掉最外层引号后,^ 转义还原成字面字符,得到程序真正收到的命令行
    const afterCmd = line.slice(1, -1).replace(/\^(.)/g, '$1')
    expect(afterCmd).toBe('C:\\Program Files\\nodejs\\npm.cmd "install" "-g" "@openai/codex"')
  })

  it('cmd 元字符不被 cmd 二次解释:& | > 等一律 ^ 转义', () => {
    const line = commandLineFor('npm', ['install', 'a&b|c>d'])
    expect(line).toContain('^&')
    expect(line).toContain('^|')
    expect(line).toContain('^>')
    const afterCmd = line.slice(1, -1).replace(/\^(.)/g, '$1')
    expect(afterCmd).toBe('npm "install" "a&b|c>d"')
  })
})

describe('第 2 条 · Windows 版本检测不再恒为空', () => {
  /** 模拟 cmd.exe 语义的假 exec:.cmd 直接跑抛 EINVAL,经 cmd.exe 跑才出版本。 */
  function winInventory(options: { files: string[]; behaviour?: Record<string, 'einval' | 'enoent' | 'ok'> }) {
    const files = new Set(options.files)
    const seen: { command: string; args: readonly string[] }[] = []
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      seen.push({ command, args })
      const target = command.toLowerCase().endsWith('cmd.exe') ? String(args[3] ?? '') : command
      const matched = Object.keys(options.behaviour ?? {}).find((key) => target.includes(key))
      const mode = matched ? options.behaviour![matched] : 'ok'
      // 没经 cmd.exe 就跑 .cmd:Node 24 起抛 EINVAL
      if (!command.toLowerCase().endsWith('cmd.exe') && command.endsWith('.cmd')) {
        const error = new Error('spawn EINVAL') as Error & { code: string }
        error.code = 'EINVAL'
        throw error
      }
      if (mode === 'einval') { const error = new Error('spawn EINVAL') as Error & { code: string }; error.code = 'EINVAL'; throw error }
      if (mode === 'enoent') { const error = new Error('not found') as Error & { code: string }; error.code = 'ENOENT'; throw error }
      return 'codex 0.153.4'
    })
    // 打桩路径不带盘符冒号:本机是 mac,path.delimiter 是 ':','C:\...' 会在 PATH 拆分时被劈开。
    // 被测逻辑只看扩展名,路径形态不影响;带空格的真实路径由 commandLineFor 的用例覆盖。
    const inv = new ShellInventory({ platform: 'win32', home: '/win/home', env: { PATH: '/win/npm' },
      recipes: () => defaultRecipes, exec, exists: async (path) => files.has(path), fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch })
    return { inv, seen }
  }

  const cmdPath = '/win/npm/codex.cmd'
  const exePath = '/win/npm/codex.exe'

  it('未知 PATH .cmd 只作为安装线索，绝不为读版本执行它', async () => {
    const { inv, seen } = winInventory({ files: [cmdPath] })
    const entry = await inv.inspect('codex')
    expect(entry).toMatchObject({ installed: true, version: '', versionUnknown: true, location: cmdPath })
    expect(seen).toEqual([])
  })

  it('PATH 同时有 .cmd 与 .exe 时也不执行任一入口', async () => {
    const { inv, seen } = winInventory({ files: [cmdPath, exePath], behaviour: { 'codex.cmd': 'einval' } })
    const entry = await inv.inspect('codex')
    expect(entry).toMatchObject({ installed: true, version: '', location: cmdPath, versionUnknown: true })
    expect(seen).toEqual([])
  })

  it('三个入口都失败:标记版本检测失败,⛔ 报成空版本的「已安装」', async () => {
    const { inv } = winInventory({ files: [cmdPath, exePath], behaviour: { codex: 'einval' } })
    const entry = await inv.inspect('codex')
    expect(entry).toMatchObject({ installed: true, version: '', versionUnknown: true })
    expect(entry.updatable).toBe(false)
  })
})

// 第 2 条的连锁:版本检测恒空 ⇒ 兼容闸门的三元判断走 undefined 分支 ⇒ 黑名单版本被放行。
// 修好检测只是堵住一个来源;闸门自己必须对「版本不知道」按不通过处理(宁可拦),
// 否则任何一种读不出版本的新情形都会重新把黑名单变成摆设。
describe('第 2 条连锁 · 版本闸门遇未知版本按不通过处理', () => {
  const entry = (version: string, installed: boolean | null = true) =>
    ({ installed, version, label: 'Claude Code' })

  it('黑名单版本照拦(闸门本职不变)', () => {
    expect(versionGateMessage(defaultRecipes, 'claude', 'deepseek', entry('2.1.154'))).toContain('等待官方修复版本')
  })

  it('版本没读出来 ⛔ 放行:空版本代入黑名单形态必须被拦下', () => {
    const blocked = versionGateMessage(defaultRecipes, 'claude', 'deepseek', entry(''))
    expect(blocked).toBeTruthy()
    expect(blocked).toContain('Claude Code')
  })

  it('版本读到且不在黑名单:照常放行', () => {
    expect(versionGateMessage(defaultRecipes, 'claude', 'deepseek', entry('2.1.153'))).toBeUndefined()
  })

  it('没装的不归版本闸门管(另有 shellInstalled 判断)', () => {
    expect(versionGateMessage(defaultRecipes, 'claude', 'deepseek', entry('', false))).toBeUndefined()
    expect(versionGateMessage(defaultRecipes, 'claude', 'deepseek', entry('', null))).toBeUndefined()
  })

  // 「宁可拦」只在真有东西可撞的时候才有意义:配方里压根没给这个壳列过不兼容版本,
  // 那「版本不知道」也撞不上任何东西,拦下来纯属挡路。今天只有 Claude Code 有黑名单条目。
  it('配方里没给这个壳列黑名单:版本不知道也照常放行', () => {
    expect(versionGateMessage(defaultRecipes, 'codex', 'deepseek', { installed: true, version: '', label: 'Codex' })).toBeUndefined()
    expect(versionGateMessage(defaultRecipes, 'hermes', 'deepseek', { installed: true, version: '', label: 'Hermes' })).toBeUndefined()
  })

  it('配方里给这个壳列过黑名单:版本不知道就拦', () => {
    const blocked = versionGateMessage(defaultRecipes, 'claude', 'deepseek', entry(''))
    expect(blocked).toBeTruthy()
    expect(blocked).toContain('Claude Code')
  })

  it('黑名单条目限定了 provider:只对那家算「有东西可撞」,别家照常放行', () => {
    const scoped = { ...defaultRecipes, incompatibilities: [
      { shell: 'codex' as const, versions: ['1.0.0'], providers: ['kimi' as const], message: '不兼容' }] }
    expect(versionGateMessage(scoped, 'codex', 'kimi', { installed: true, version: '', label: 'Codex' })).toBeTruthy()
    expect(versionGateMessage(scoped, 'codex', 'deepseek', { installed: true, version: '', label: 'Codex' })).toBeUndefined()
  })
})

describe('AI 接入闸门只执行受信任的固定安装入口', () => {
  it('PATH 中未知 Hermes 包装器不会被 --version 触发，并给出可操作的未确认提示', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-gate-wrapper-'))
    const wrapper = join(root, 'bin', 'hermes')
    const touched = join(root, 'wrapper-ran')
    try {
      await mkdir(join(root, 'bin'), { recursive: true })
      await writeFile(wrapper, `#!/bin/sh\ntouch ${touched}\necho hermes 9.9.9\n`)
      await chmod(wrapper, 0o755)

      const message = await trustedVersionGateMessage(defaultRecipes, 'hermes', 'deepseek', 'linux', root,
        { PATH: join(root, 'bin'), HERMES_HOME: join(root, 'missing-hermes') })

      expect(message).toContain('未能在官方安装位置确认 Hermes')
      await expect(access(touched)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('受信任 Hermes venv 入口可用于版本闸门，不从 PATH 选命令', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-gate-trusted-')))
    try {
      await writeTrustedHermesFixture(root, 'hermes 0.21.0')

      const recipes = { ...defaultRecipes, incompatibilities: [
        { shell: 'hermes' as const, versions: ['0.21.0'], providers: ['deepseek' as const], message: '受信任版本不兼容' }
      ] }
      await expect(trustedVersionGateMessage(recipes, 'hermes', 'deepseek', 'linux', root,
        { PATH: join(root, 'wrapper-bin') })).resolves.toBe('受信任版本不兼容')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('受信任 Codex 版本读不出时明确阻止；普通 Hermes shell 脚本不冒充官方入口', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-gate-unknown-version-')))
    // Use the fixed npm vendor location on Linux. A Darwin app candidate could otherwise pick
    // up the developer machine's installed ChatGPT/Codex app before this isolated fixture.
    const codex = join(root, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex')
    const hermesRoot = join(root, '.hermes')
    const hermes = join(hermesRoot, 'hermes-agent', 'venv', 'bin', 'hermes')
    try {
      await mkdir(dirname(codex), { recursive: true })
      await mkdir(dirname(hermes), { recursive: true })
      // Native magic but no runnable program: it is an official-path candidate whose version is unknown.
      await writeFile(codex, Buffer.from('cafebabe', 'hex'), { mode: 0o700 })
      await chmod(codex, 0o700)
      await writeFile(hermes, '#!/bin/sh\necho no-version-here\n')
      await chmod(hermes, 0o755)

      await expect(trustedVersionGateMessage(defaultRecipes, 'codex', 'deepseek', 'linux', root, { PATH: join(root, 'bin') }))
        .resolves.toContain('暂时无法确认 Codex 的版本')
      await expect(trustedVersionGateMessage(defaultRecipes, 'hermes', 'deepseek', 'linux', root,
        { PATH: join(root, 'bin') })).resolves.toContain('未能在官方安装位置确认 Hermes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('第 1 条补充 · 路径形态不该骗过判断', () => {
  it('含点的目录名不算扩展名:C:\\Users\\a.b\\npm\\codex 仍然要经 cmd.exe', () => {
    expect(needsCommandShell('win32', 'C:\\Users\\a.b\\npm\\codex')).toBe(true)
    expect(needsCommandShell('win32', 'C:\\Users\\a.b\\npm\\codex.cmd')).toBe(true)
    expect(needsCommandShell('win32', 'C:\\Users\\a.b\\npm\\codex.exe')).toBe(false)
    expect(needsCommandShell('darwin', '/usr/local/bin/codex')).toBe(false)
  })
})
