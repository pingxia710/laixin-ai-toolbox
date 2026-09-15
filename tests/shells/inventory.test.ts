import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { spawn as spawnType } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultRecipes, type Recipes } from '../../app/main/recipes/recipes'
import { ShellInventory, augmentedEnvironment, parseVersion, trustedCliCommandCandidates, trustedCliExecutable, trustedCliInstalled, trustedCliVersion, trustedHermesCommandCandidates, trustedHermesEnvironment, trustedHermesExecutable } from '../../app/main/shells/inventory'
import { ShellInstaller } from '../../app/main/shells/installer'

function inventory(options: { files?: string[]; versions?: Record<string, string>; recipes?: Recipes; fetch?: typeof fetch; platform?: string } = {}) {
  const files = new Set(options.files ?? [])
  const exec = vi.fn(async (command: string, args: readonly string[]) => {
    const name = command.split('/').pop()!.replace(/\.(cmd|exe)$/, '')
    if (command.endsWith('PlistBuddy')) return options.versions?.[args[2]] ?? ''
    return `${name} ${options.versions?.[name] ?? '0.0.0'}`
  })
  const inv = new ShellInventory({ platform: options.platform ?? 'darwin', home: '/Users/t', env: { PATH: '/usr/bin' },
    recipes: () => options.recipes ?? defaultRecipes, exec, exists: async (path) => files.has(path), realpath: async path => path,
    // Unit fixtures are paths only. They must never accidentally probe a host-installed CLI.
    trustedVersion: async () => undefined,
    validateHermesExecutable: async candidate => files.has(candidate) && candidate.endsWith('/hermes-agent/venv/bin/hermes'),
    fetch: options.fetch, now: () => 1_800_000_000_000 })
  return { inv, exec }
}

describe('六壳安装检测', () => {
  it('Windows Hermes 受信环境只使用固定系统目录，忽略继承的 SystemRoot', () => {
    expect(trustedHermesEnvironment('win32', 'C:\\Users\\t\\AppData\\Local\\hermes', {
      SystemRoot: 'D:\\untrusted', SYSTEMROOT: 'E:\\untrusted'
    })).toEqual({
      HERMES_HOME: 'C:\\Users\\t\\AppData\\Local\\hermes',
      PATH: 'C:\\Windows\\System32;C:\\Windows',
      SystemRoot: 'C:\\Windows'
    })
  })

  it('真实 Key 验收的可信 CLI 候选不读取 PATH，Claude 只认官方版本目录中的原生入口', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-trusted-cli-')))
    const wrapper = join(root, 'bin', 'codex')
    const nativeClaude = join(root, '.local', 'bin', 'claude')
    const claude = join(root, '.local', 'share', 'claude', 'versions', '2.1.270')
    try {
      await mkdir(join(root, 'bin'), { recursive: true })
      await mkdir(dirname(nativeClaude), { recursive: true })
      await mkdir(dirname(claude), { recursive: true })
      await writeFile(wrapper, '#!/bin/sh\necho wrapper\n')
      await writeFile(nativeClaude, Buffer.from('cafebabe', 'hex'))
      await writeFile(claude, Buffer.from('cafebabe', 'hex'))

      const env = { PATH: join(root, 'bin') }
      expect(await trustedCliCommandCandidates('codex', 'darwin', root, env)).not.toContain(wrapper)
      // Linux has no desktop-app candidate; a PATH wrapper alone must still not become installed.
      expect(await trustedCliInstalled('codex', 'linux', root, env)).toBe(false)
      expect(await trustedCliCommandCandidates('claude-code', 'darwin', root, env)).toEqual([nativeClaude, claude])
      expect(await trustedCliInstalled('claude-code', 'darwin', root, env)).toBe(true)
      expect(await trustedCliExecutable('claude-code', 'darwin', root, env)).toBe(nativeClaude)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('执行入口拒绝受信目录中的符号链接，PATH 中的包装器也不能替代它', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-trusted-cli-link-')))
    const external = join(root, 'external-claude')
    const linked = join(root, '.local', 'share', 'claude', 'versions', '2.1.271')
    try {
      await mkdir(dirname(linked), { recursive: true })
      await writeFile(external, Buffer.from('cffaedfe', 'hex'))
      await symlink(external, linked)

      expect(await trustedCliExecutable('claude-code', 'darwin', root, { PATH: join(root, 'bin') })).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('可信 Codex 候选跨平台只列固定官方位置，不把外部二进制或 PATH 包装器列进来', async () => {
    const darwin = await trustedCliCommandCandidates('codex', 'darwin', '/Users/t', { PATH: '/private/wrapper-bin' })
    expect(darwin).toEqual(expect.arrayContaining([
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Users/t/Applications/Codex.app/Contents/Resources/codex',
      '/Users/t/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Users/t/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
    ]))
    const windows = await trustedCliCommandCandidates('codex', 'win32', 'C:\\Users\\t', { PATH: 'C:\\wrapper-bin' })
    expect(windows).toEqual(expect.arrayContaining([
      'C:\\Users\\t\\AppData\\Local\\Programs\\Codex\\resources\\codex.exe',
      'C:\\Users\\t\\AppData\\Local\\Programs\\ChatGPT\\resources\\codex.exe',
      'C:\\Users\\t\\AppData\\Local\\ChatGPT\\resources\\codex.exe',
      'C:\\Users\\t\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'
    ]))
    expect(await trustedCliCommandCandidates('claude-code', 'darwin', '/Users/t', { PATH: '/private/wrapper-bin' })).toEqual([
      '/Users/t/.local/bin/claude'
    ])
    expect(await trustedCliCommandCandidates('claude-code', 'win32', 'C:\\Users\\t', { PATH: 'C:\\wrapper-bin' })).toEqual([
      'C:\\Users\\t\\.local\\bin\\claude.exe'
    ])
  })

  it('官方 npm Codex 安装只接受包内原生 vendor 二进制，不接受 PATH shim', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-trusted-codex-npm-')))
    const native = join(root, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex')
    try {
      await mkdir(dirname(native), { recursive: true })
      await writeFile(native, Buffer.from('cafebabe', 'hex'))
      const candidates = await trustedCliCommandCandidates('codex', 'linux', root, { PATH: join(root, 'bin') })
      expect(candidates).toContain(native)
      expect(await trustedCliExecutable('codex', 'linux', root, { PATH: join(root, 'bin') })).toBe(native)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('Claude 官方固定目录中的脚本包装器也不能成为可执行入口', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-trusted-claude-wrapper-')))
    const wrapper = join(root, '.local', 'bin', 'claude')
    try {
      await mkdir(dirname(wrapper), { recursive: true })
      await writeFile(wrapper, '#!/bin/sh\necho wrapper\n')
      expect(await trustedCliExecutable('claude-code', 'darwin', root, { PATH: dirname(wrapper) })).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('所有壳只把 PATH 命中当作安装线索，绝不执行未知入口', async () => {
    const { inv, exec } = inventory({ files: ['/opt/homebrew/bin/dsh', '/usr/bin/codex', '/usr/bin/claude'], versions: { dsh: '0.153.4' } })
    const harness = await inv.inspect('deepseek-harness')
    const codex = await inv.inspect('codex'), claude = await inv.inspect('claude-code')
    expect(harness).toMatchObject({ installed: true, version: '', versionUnknown: true, location: '/opt/homebrew/bin/dsh', method: 'npm' })
    expect(codex).toMatchObject({ installed: true, version: '', versionUnknown: true, location: '/usr/bin/codex' })
    expect(claude).toMatchObject({ installed: true, version: '', versionUnknown: true, location: '/usr/bin/claude' })
    expect(exec).not.toHaveBeenCalled()
    expect(augmentedEnvironment('darwin', '/Users/t', { PATH: '/usr/bin' }).PATH).toContain('/opt/homebrew/bin')
    expect(parseVersion('codex-cli 0.153.4 (abc)')).toBe('0.153.4')
  })

  it('list 盘点 dsh 与 Kimi 的 PATH 包装器时也绝不调用 --version', async () => {
    const { inv, exec } = inventory({ files: ['/usr/bin/dsh', '/usr/bin/kimi'] })

    const entries = await inv.list()

    expect(entries.find(entry => entry.id === 'deepseek-harness')).toMatchObject({ installed: true, versionUnknown: true, location: '/usr/bin/dsh' })
    expect(entries.find(entry => entry.id === 'kimi-code')).toMatchObject({ installed: true, versionUnknown: true, location: '/usr/bin/kimi' })
    expect(exec).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('list 实际遇到 dsh 与 Kimi PATH 包装器时不执行标记脚本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-passive-shell-list-'))
    const wrappers = join(root, 'wrappers')
    const marker = join(root, 'wrapper-ran')
    try {
      await mkdir(wrappers, { recursive: true })
      for (const command of ['dsh', 'kimi']) {
        const wrapper = join(wrappers, command)
        await writeFile(wrapper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 })
        await chmod(wrapper, 0o755)
      }
      const inv = new ShellInventory({
        platform: 'linux', home: root, env: { PATH: wrappers }, recipes: () => defaultRecipes,
        fetch: (async () => new Response('', { status: 503 })) as typeof fetch
      })

      const entries = await inv.list()

      expect(entries.find(entry => entry.id === 'deepseek-harness')).toMatchObject({ installed: true, versionUnknown: true, location: join(wrappers, 'dsh') })
      expect(entries.find(entry => entry.id === 'kimi-code')).toMatchObject({ installed: true, versionUnknown: true, location: join(wrappers, 'kimi') })
      await expect(access(marker)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('没找到命令也没找到应用 = 未安装；无法判断的系统标 null', async () => {
    const { inv } = inventory()
    expect((await inv.inspect('codex')).installed).toBe(false)
    const { inv: win } = inventory({ platform: 'win32' })
    expect((await win.inspect('zcode')).installed).toBeNull()
  })

  it('macOS 应用包按 Info.plist 读版本', async () => {
    const plist = '/Applications/ZCode.app/Contents/Info.plist'
    const { inv } = inventory({ files: [plist], versions: { [plist]: '1.4.0' } })
    expect(await inv.inspect('zcode')).toMatchObject({ installed: true, version: '1.4.0', method: 'app' })
  })

  it('Hermes 盘点跳过 PATH 未知包装器，优先验证受信任安装根中的命令', async () => {
    const wrapper = '/usr/bin/hermes'
    const native = '/Users/t/.hermes/hermes-agent/venv/bin/hermes'
    const { inv, exec } = inventory({ files: [wrapper, native], versions: { hermes: '0.21.0' } })

    const entry = await inv.inspect('hermes')

    expect(entry).toMatchObject({ installed: true, version: '0.21.0', versionUnknown: false, location: native })
    expect(exec.mock.calls.map(call => call[0])).toEqual([native])
  })

  it('只有未知 Hermes 包装器时仍显示已发现但版本未知，绝不执行包装器', async () => {
    const wrapper = '/usr/bin/hermes'
    const { inv, exec } = inventory({ files: [wrapper] })

    expect(await inv.inspect('hermes')).toMatchObject({ installed: true, version: '', versionUnknown: true, location: wrapper })
    expect(exec).not.toHaveBeenCalled()
  })

  it('自定义 HERMES_HOME 的固定 virtualenv 启动器可被验证并执行', async () => {
    const native = '/customer/hermes-home/hermes-agent/venv/bin/hermes'
    const exec = vi.fn(async (command: string) => { void command; return 'hermes 0.21.0' })
    const inv = new ShellInventory({ platform: 'darwin', home: '/Users/t', env: { PATH: '/usr/bin', HERMES_HOME: '/customer/hermes-home' }, recipes: () => defaultRecipes,
      exec, exists: async path => path === native, realpath: async path => path, validateHermesExecutable: async candidate => candidate === native })

    expect(await inv.inspect('hermes')).toMatchObject({ installed: true, version: '0.21.0', versionUnknown: false, location: native })
    expect(exec.mock.calls.map(call => call[0])).toEqual([native])
    expect(trustedHermesCommandCandidates('win32', 'C:\\Users\\t\\AppData\\Local\\hermes')).toEqual([
      'C:\\Users\\t\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe'
    ])
  })

  it('HERMES_HOME 内的 generic bin/hermes 包装器不会获得执行信任', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-hermes-inventory-'))
    const candidate = join(root, 'bin', 'hermes')
    await mkdir(join(root, 'bin'), { recursive: true })
    await writeFile(candidate, '#!/bin/sh\necho wrapper\n')
    const exec = vi.fn(async () => 'hermes 0.21.0')
    const inv = new ShellInventory({ platform: 'darwin', home: '/Users/t', env: { PATH: join(root, 'bin'), HERMES_HOME: root }, recipes: () => defaultRecipes, exec })
    try {
      expect(await inv.inspect('hermes')).toMatchObject({ installed: true, version: '', versionUnknown: true, location: candidate })
      expect(exec).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('只接受候选自身固定布局中的官方 Python console-script，不执行普通 shell 包装器或附带命令', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'laixin-hermes-console-script-')))
    const root = join(home, '.hermes')
    const launcher = join(root, 'hermes-agent', 'venv', 'bin', 'hermes')
    const official = [
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
    try {
      await mkdir(dirname(launcher), { recursive: true })
      await writeFile(launcher, official)

      expect(await trustedHermesExecutable(launcher, 'linux')).toBe(true)
      await writeFile(launcher, '#!/bin/sh\necho wrapper\n')
      expect(await trustedHermesExecutable(launcher, 'linux')).toBe(false)
      await writeFile(launcher, `${official}echo unexpected\n`)
      expect(await trustedHermesExecutable(launcher, 'linux')).toBe(false)
      await rm(launcher)
      await writeFile(join(root, 'outside-hermes'), official)
      await symlink(join(root, 'outside-hermes'), launcher)
      expect(await trustedHermesExecutable(launcher, 'linux')).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('搬家的 HERMES_HOME 读版本会清理客户 PATH，console-script 不会调用 dirname 或 realpath 包装器', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'laixin-hermes-safe-env-')))
    const root = join(home, 'relocated-hermes')
    const launcher = join(root, 'hermes-agent', 'venv', 'bin', 'hermes')
    const python = join(root, 'hermes-agent', 'venv', 'bin', 'python3')
    const wrapperDirectory = join(home, 'wrappers')
    const marker = join(home, 'wrapper-ran')
    const official = [
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
    try {
      await Promise.all([mkdir(dirname(launcher), { recursive: true }), mkdir(wrapperDirectory, { recursive: true })])
      await writeFile(launcher, official, { mode: 0o700 })
      await writeFile(python, '#!/bin/sh\necho "hermes 0.21.0"\n', { mode: 0o700 })
      for (const utility of ['dirname', 'realpath']) {
        const wrapper = join(wrapperDirectory, utility)
        await writeFile(wrapper, `#!/bin/sh\n: > ${marker}\nexit 1\n`, { mode: 0o700 })
        await chmod(wrapper, 0o700)
      }
      await chmod(launcher, 0o700); await chmod(python, 0o700)

      await expect(trustedCliVersion('hermes', 'linux', home, { PATH: wrapperDirectory, HERMES_HOME: root })).resolves.toMatchObject({ executable: launcher, version: '0.21.0', versionUnknown: false })
      await expect(access(marker)).rejects.toThrow()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('最新版：配方优先；否则查 npm 注册表并回退镜像；结果缓存', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      if (url.startsWith('https://registry.npmjs.org')) throw new Error('blocked')
      return new Response(JSON.stringify({ version: '0.160.0' }), { status: 200 })
    }) as unknown as typeof fetch
    const { inv } = inventory({ files: ['/usr/bin/dsh'], versions: { dsh: '0.153.4' }, fetch: fetchImpl })
    const entry = await inv.inspect('deepseek-harness')
    // A generic PATH hit remains a visible installation clue but is deliberately not executed.
    expect(entry).toMatchObject({ latest: '0.160.0', updatable: false, versionUnknown: true })
    expect(calls).toEqual(['https://registry.npmjs.org/@deepseek-ai/dsh/latest', 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest'])
    await inv.inspect('deepseek-harness')
    expect(calls).toHaveLength(2)
    const pinned = { ...defaultRecipes, shells: { ...defaultRecipes.shells, 'deepseek-harness': { ...defaultRecipes.shells['deepseek-harness'], latest: '0.153.4' } } }
    const { inv: pinnedInv } = inventory({ files: ['/usr/bin/dsh'], versions: { dsh: '0.153.4' }, recipes: pinned, fetch: fetchImpl })
    expect(await pinnedInv.inspect('deepseek-harness')).toMatchObject({ latest: '0.153.4', updatable: false })
  })
})

function fakeSpawn(plan: Record<string, number>) {
  const seen: string[] = []
  const spawnImpl = ((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => undefined
    const key = args.includes('--registry') ? args[args.indexOf('--registry') + 1] : command
    seen.push(key)
    setTimeout(() => { child.stdout.emit('data', Buffer.from(`ran ${key}\n`)); child.emit('close', plan[key] ?? 0) }, 5)
    return child
  }) as unknown as typeof spawnType
  return { spawnImpl, seen }
}

describe('官方安装执行器', () => {
  const wait = (installer: ShellInstaller) => new Promise<void>((resolve) => { const t = setInterval(() => { if (installer.status().phase !== 'running') { clearInterval(t); resolve() } }, 5) })

  it('npm 官方源失败自动换镜像，装完重新检测才算成功', async () => {
    const files = new Set<string>()
    const inv = new ShellInventory({ platform: 'darwin', home: '/Users/t', env: {}, recipes: () => defaultRecipes,
      exec: async () => 'dsh 1.2.3', exists: async (path) => files.has(path) })
    const { spawnImpl, seen } = fakeSpawn({ 'https://registry.npmjs.org': 1, 'https://registry.npmmirror.com': 0 })
    const installer = new ShellInstaller({ platform: 'darwin', recipes: () => defaultRecipes, inventory: inv, proxyUrl: () => undefined, spawn: spawnImpl })
    files.add('/opt/homebrew/bin/dsh')
    installer.start('deepseek-harness'); await wait(installer)
    expect(seen).toEqual(['https://registry.npmjs.org', 'https://registry.npmmirror.com'])
    expect(installer.status()).toMatchObject({ phase: 'succeeded', message: 'installed', attempt: 2 })
    expect(installer.status().after).toMatchObject({ installed: true, version: '', versionUnknown: true })
  })

  it('命令都失败 → failed 并保留输出尾部；装了但检测不到 → not-detected', async () => {
    const inv = new ShellInventory({ platform: 'darwin', home: '/Users/t', env: {}, recipes: () => defaultRecipes, exec: async () => '', exists: async () => false,
      // Keep this installer fixture isolated from a real desktop Codex application on the host.
      trustedVersion: async () => undefined })
    const all = fakeSpawn({ 'https://registry.npmjs.org': 1, 'https://registry.npmmirror.com': 1 })
    const installer = new ShellInstaller({ platform: 'darwin', recipes: () => defaultRecipes, inventory: inv, proxyUrl: () => undefined, spawn: all.spawnImpl })
    installer.start('codex'); await wait(installer)
    expect(installer.status()).toMatchObject({ phase: 'failed', message: 'command-failed' })
    expect(installer.status().log.some((line) => line.includes('ran https://registry.npmmirror.com'))).toBe(true)
    const ok = fakeSpawn({})
    const installer2 = new ShellInstaller({ platform: 'darwin', recipes: () => defaultRecipes, inventory: inv, proxyUrl: () => undefined, spawn: ok.spawnImpl })
    installer2.start('codex'); await wait(installer2)
    expect(installer2.status()).toMatchObject({ phase: 'failed', message: 'not-detected' })
  })

  it('脚本类安装先直连、通道可用时再经通道；应用类没有命令直接 failed no-command', async () => {
    const inv = new ShellInventory({ platform: 'darwin', home: '/Users/t', env: {}, recipes: () => defaultRecipes, exec: async () => '', exists: async () => false })
    const { spawnImpl, seen } = fakeSpawn({ bash: 1 })
    const installer = new ShellInstaller({ platform: 'darwin', recipes: () => defaultRecipes, inventory: inv, proxyUrl: () => 'http://127.0.0.1:47890', spawn: spawnImpl })
    installer.start('claude-code'); await wait(installer)
    expect(seen).toEqual(['bash', 'bash'])
    expect(installer.status().phase).toBe('failed')
    expect(installer.start('zcode')).toMatchObject({ phase: 'failed', message: 'no-command' })
  })
})
