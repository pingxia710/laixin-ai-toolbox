import { readFile, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupStamp, cleanRegistryEnv, cleanShellExports, commentPrefix, markClaudeOnboarded,
  restoreClaudeOnboarding, restoreRegistryEnv, restoreShellExports
} from '../../app/main/ai-access/hidden-state-cleanup'
import { scanHiddenState, type HiddenStateFinding } from '../../app/main/ai-access/hidden-state'

// 全部在临时目录里造，⛔ 碰本机的 ~/.zshrc ~/.claude.json。
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function workspace(): Promise<{ home: string; backupDir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'laixin-hidden-clean-'))
  roots.push(home)
  return { home, backupDir: join(home, 'backups') }
}

const onboarded = JSON.stringify({ hasCompletedOnboarding: true })
const at = new Date('2026-09-13T19:05:01')

async function findings(home: string): Promise<readonly HiddenStateFinding[]> {
  const report = await scanHiddenState({ platform: 'darwin', home, env: {}, readSystemProxy: async () => null })
  return report.findings
}

describe('停用 shell 启动文件里的旧设置', () => {
  it('⛔ 删行：原行前面加注释，改前整份备份', async () => {
    const { home, backupDir } = await workspace()
    const path = join(home, '.zshrc')
    const original = ['# 我自己的设置', 'export ANTHROPIC_AUTH_TOKEN=sk-ant-0123456789abcdef', 'export PATH="$PATH:/opt/bin"', ''].join('\n')
    await writeFile(path, original, 'utf8')
    await writeFile(join(home, '.claude.json'), onboarded, 'utf8')

    const receipt = await cleanShellExports(await findings(home), { backupDir, now: () => at })
    expect(receipt.entries).toHaveLength(1)
    expect(receipt.failures).toEqual([])

    const after = await readFile(path, 'utf8')
    expect(after).toContain(`${commentPrefix(at)}export ANTHROPIC_AUTH_TOKEN=sk-ant-0123456789abcdef`)
    // 行还在，只是被注释掉了：客户随时能自己看回来。
    expect(after).toContain('sk-ant-0123456789abcdef')
    expect(after.split('\n')).toHaveLength(original.split('\n').length)
    expect(after).toContain('export PATH="$PATH:/opt/bin"')

    const backupPath = join(backupDir, `.zshrc.${backupStamp(at)}.bak`)
    expect(receipt.entries[0].backupPath).toBe(backupPath)
    expect(await readFile(backupPath, 'utf8')).toBe(original)
    expect(receipt.notes[0]).toContain('新开一个终端')
  })

  it('撤销后逐字节一模一样，撤两次也一样（幂等）', async () => {
    const { home, backupDir } = await workspace()
    const path = join(home, '.zshrc')
    // CRLF 也要能原样还回去。
    const original = Buffer.from(['export OPENAI_API_KEY=sk-openai-0123456789abcdef\r', 'export KIMI_API_KEY=sk-kimi-0123456789abcdef\r', ''].join('\n'), 'utf8')
    await writeFile(path, original)
    await writeFile(join(home, '.claude.json'), onboarded, 'utf8')

    const receipt = await cleanShellExports(await findings(home), { backupDir, now: () => at })
    expect(receipt.entries).toHaveLength(2)
    expect(await readFile(path)).not.toEqual(original)

    const first = await restoreShellExports(receipt)
    expect(first.map((item) => item.outcome)).toEqual(['restored', 'restored'])
    expect(await readFile(path)).toEqual(original)

    const second = await restoreShellExports(receipt)
    expect(second.map((item) => item.outcome)).toEqual(['already-restored', 'already-restored'])
    expect(await readFile(path)).toEqual(original)
  })

  it('清理后再扫，这几条就没了', async () => {
    const { home, backupDir } = await workspace()
    await writeFile(join(home, '.zshrc'), 'export OPENAI_API_KEY=sk-openai-0123456789abcdef\n', 'utf8')
    await writeFile(join(home, '.claude.json'), onboarded, 'utf8')
    await cleanShellExports(await findings(home), { backupDir, now: () => at })
    expect(await findings(home)).toEqual([])
  })

  it('这行在中间被客户改过就不动它，**⛔ 蒙着改**', async () => {
    const { home, backupDir } = await workspace()
    const path = join(home, '.zshrc')
    await writeFile(path, 'export OPENAI_API_KEY=sk-openai-0123456789abcdef\n', 'utf8')
    await writeFile(join(home, '.claude.json'), onboarded, 'utf8')
    const stale = await findings(home)

    const rewritten = 'export SOMETHING_ELSE=1\n'
    await writeFile(path, rewritten, 'utf8')
    const receipt = await cleanShellExports(stale, { backupDir, now: () => at })
    expect(receipt.entries).toEqual([])
    expect(receipt.failures[0].reason).toContain('重新检查')
    expect(await readFile(path, 'utf8')).toBe(rewritten)
  })

  it('配置目录、系统代理这类只报告的，⛔ 被清理掉', async () => {
    const { home, backupDir } = await workspace()
    const path = join(home, '.zshrc')
    const original = 'export CODEX_HOME=/opt/codex-home\n'
    await writeFile(path, original, 'utf8')
    await writeFile(join(home, '.claude.json'), onboarded, 'utf8')
    // 整份扫描结果原样交给清理，靠 cleanable 自己拦住。
    const receipt = await cleanShellExports(await findings(home), { backupDir, now: () => at })
    expect(receipt.entries).toEqual([])
    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(readdir(backupDir)).rejects.toThrow()
  })
})

describe('停用软链过去的启动文件（dotfiles 常态）', () => {
  it('改的是链接指向的那个文件，链接本身仍是链接', async () => {
    const { home, backupDir } = await workspace()
    await mkdir(join(home, 'dotfiles'), { recursive: true })
    const target = join(home, 'dotfiles', 'bashrc')
    const original = 'export OPENAI_API_KEY=sk-openai-0123456789abcdef\n'
    await writeFile(target, original, 'utf8')
    await symlink(target, join(home, '.bashrc'))
    await writeFile(join(home, '.claude.json'), onboarded, 'utf8')

    const receipt = await cleanShellExports(await findings(home), { backupDir, now: () => at })
    expect(receipt.entries).toHaveLength(1)
    // 客户看到的是 ~/.bashrc，动的是 dotfiles/bashrc。
    expect(receipt.entries[0].source).toBe(join(home, '.bashrc'))
    expect(receipt.entries[0].file).toContain('dotfiles/bashrc')
    expect(await readFile(target, 'utf8')).toContain(`${commentPrefix(at)}export OPENAI_API_KEY=`)
    // **⛔ 把客户的软链换成普通文件**——原子写的 rename 很容易干出这事。
    expect((await lstat(join(home, '.bashrc'))).isSymbolicLink()).toBe(true)
    expect(await readFile(receipt.entries[0].backupPath, 'utf8')).toBe(original)

    expect((await restoreShellExports(receipt)).map((item) => item.outcome)).toEqual(['restored'])
    expect(await readFile(target, 'utf8')).toBe(original)
    expect((await lstat(join(home, '.bashrc'))).isSymbolicLink()).toBe(true)
  })

  it('引导标记也一样：写目标文件，⛔ 顶掉软链', async () => {
    const { home, backupDir } = await workspace()
    await mkdir(join(home, 'dotfiles'), { recursive: true })
    const target = join(home, 'dotfiles', 'claude.json')
    await writeFile(target, JSON.stringify({ theme: 'dark' }), 'utf8')
    const link = join(home, '.claude.json')
    await symlink(target, link)

    const entry = await markClaudeOnboarded(link, { backupDir, now: () => at })
    expect(entry.changed).toBe(true)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    // 原有的键必须还在：读不出来就当空文件，会把客户的整份配置冲掉。
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ theme: 'dark', hasCompletedOnboarding: true })
  })
})

describe('停用 Windows 注册表里的环境变量', () => {
  const finding = (name: string): HiddenStateFinding => ({
    id: name, kind: 'registry_env', source: 'HKCU\\Environment', name, valueMasked: 'sk-a••••cdef',
    affects: ['claude'], severity: 'warning', impact: '', suggestion: '', cleanable: true, scope: 'user'
  })

  it('先整键导出备份，再逐条删；恢复走 reg import 且一个键只导一次', async () => {
    const { backupDir } = await workspace()
    const calls: string[][] = []
    const exec = async (command: string, args: readonly string[]): Promise<string> => { calls.push([command, ...args]); return '' }
    const receipt = await cleanRegistryEnv([finding('ANTHROPIC_API_KEY'), finding('OPENAI_API_KEY')], { backupDir, exec, now: () => at })

    expect(calls[0][1]).toBe('export')
    expect(calls.filter((call) => call[1] === 'export')).toHaveLength(1)
    expect(calls.filter((call) => call[1] === 'delete').map((call) => call[4])).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
    expect(receipt.entries).toHaveLength(2)
    // ⛔ 广播 WM_SETTINGCHANGE，只在凭据里说清楚要新开终端。
    expect(calls.some((call) => call.join(' ').includes('SETTINGCHANGE'))).toBe(false)
    expect(receipt.notes[0]).toContain('新开一个终端')

    calls.length = 0
    const restored = await restoreRegistryEnv(receipt, { exec })
    expect(calls.filter((call) => call[1] === 'import')).toHaveLength(1)
    expect(restored.map((item) => item.outcome)).toEqual(['restored', 'restored'])
  })

  it('删不动（HKLM 要管理员）只记这一条失败，⛔ 把整批带下水', async () => {
    const { backupDir } = await workspace()
    const exec = async (_command: string, args: readonly string[]): Promise<string> => {
      if (args[0] === 'delete' && args[3] === 'OPENAI_API_KEY') throw Object.assign(new Error('拒绝访问'), { code: 'EPERM' })
      return ''
    }
    const receipt = await cleanRegistryEnv([finding('ANTHROPIC_API_KEY'), finding('OPENAI_API_KEY')], { backupDir, exec, now: () => at })
    expect(receipt.entries.map((entry) => entry.name)).toEqual(['ANTHROPIC_API_KEY'])
    expect(receipt.failures).toEqual([{ source: 'HKCU\\Environment', name: 'OPENAI_API_KEY', reason: '没有写入权限' }])
  })

  it('备份都没做成就一条都不删', async () => {
    const { backupDir } = await workspace()
    const calls: string[][] = []
    const exec = async (command: string, args: readonly string[]): Promise<string> => {
      calls.push([command, ...args])
      if (args[0] === 'export') throw new Error('磁盘满了')
      return ''
    }
    const receipt = await cleanRegistryEnv([finding('ANTHROPIC_API_KEY')], { backupDir, exec, now: () => at })
    expect(calls.some((call) => call[1] === 'delete')).toBe(false)
    expect(receipt.failures[0].reason).toContain('备份失败')
  })
})

describe('写 Claude 的引导标记', () => {
  it('只动这一个键，其余原样；备份留着可撤销', async () => {
    const { home, backupDir } = await workspace()
    const path = join(home, '.claude.json')
    const original = JSON.stringify({ hasCompletedOnboarding: false, projects: { '/a': { history: [1, 2] } }, theme: 'dark' }, null, 2)
    await writeFile(path, original, 'utf8')

    const entry = await markClaudeOnboarded(path, { backupDir, now: () => at })
    expect(entry.changed).toBe(true)
    const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(after).toEqual({ hasCompletedOnboarding: true, projects: { '/a': { history: [1, 2] } }, theme: 'dark' })
    expect(await readFile(entry.backupPath as string, 'utf8')).toBe(original)

    expect((await restoreClaudeOnboarding(entry)).outcome).toBe('restored')
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('已经是 true 就不动文件、也不留备份', async () => {
    const { home, backupDir } = await workspace()
    const path = join(home, '.claude.json')
    await writeFile(path, onboarded, 'utf8')
    const before = await stat(path)
    const entry = await markClaudeOnboarded(path, { backupDir, now: () => at })
    expect(entry).toMatchObject({ changed: false, backupPath: null })
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
  })

  it('文件不在就新建一份；内容坏掉就报错不动它', async () => {
    const { home, backupDir } = await workspace()
    const fresh = join(home, 'fresh', '.claude.json')
    const entry = await markClaudeOnboarded(fresh, { backupDir, now: () => at })
    expect(entry).toMatchObject({ changed: true, backupPath: null })
    expect(JSON.parse(await readFile(fresh, 'utf8'))).toEqual({ hasCompletedOnboarding: true })
    // 新建出来的没有「原样」可撤，说清楚⛔ 假装撤过。
    expect((await restoreClaudeOnboarding(entry)).outcome).toBe('already-restored')

    const broken = join(home, '.claude.json')
    await writeFile(broken, '{ 这不是 JSON', 'utf8')
    await expect(markClaudeOnboarded(broken, { backupDir, now: () => at })).rejects.toThrow()
    expect(await readFile(broken, 'utf8')).toBe('{ 这不是 JSON')
  })
})
