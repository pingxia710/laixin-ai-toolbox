import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createDeepSeekAdapters } from '../../app/main/ai-access/adapters'
import { createManagedTextFile } from '../../app/main/ai-access/file'

const execFile = promisify(execFileCallback)
const KEY = 'sk-test1234567890abcdef'

/** 在内存里逐键模拟真实 hermes CLI：set 落值；unset 缺键 = 非零退出（≥0.21 实测语义）。 */
function faithfulCli(initial: Record<string, string> = {}) {
  const settings = new Map<string, string | undefined>(Object.entries(initial))
  const run = async (_command: string, args: readonly string[]): Promise<void> => {
    if (args[0] === 'config' && args[1] === 'set') { settings.set(args[2], args[3]); return }
    if (args[0] === 'config' && args[1] === 'unset') {
      if (!settings.has(args[2])) throw new Error(`Config key not set: ${args[2]}`)
      settings.delete(args[2]); return
    }
    throw new Error(`unexpected command: ${args.join(' ')}`)
  }
  const readKey = async (_command: string, key: string): Promise<string | undefined> => settings.get(key)
  return { run, readKey, settings }
}

function hermesAdapter(home: string, cli: ReturnType<typeof faithfulCli>) {
  const adapters = createDeepSeekAdapters({
    home, platform: 'darwin', file: createManagedTextFile(),
    findHermesCommand: async () => 'hermes',
    runHermes: cli.run, readHermesConfig: cli.readKey
  })
  const hermes = adapters.find(adapter => adapter.shell === 'hermes')
  if (hermes === undefined) throw new Error('hermes adapter missing')
  return hermes
}

describe('hermes unset 容错（真实 CLI ≥0.21 的非零退出）', () => {
  it('直连启用在干净配置上成功：unset 缺键被复核为幂等成功', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-tol-'))
    try {
      const cli = faithfulCli()
      await hermesAdapter(home, cli).applyDeepSeek!(KEY)
      expect(cli.settings.get('model.provider')).toBe('deepseek')
      expect(cli.settings.get('model.default')).toBe('deepseek-flash')
      expect(cli.settings.get('model.api_mode')).toBe('chat_completions')
      expect(cli.settings.has('model.base_url')).toBe(false)
      expect(cli.settings.has('model.api_key')).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('unset 真实失败（键仍在）仍上抛并完整回滚，不被容错吞掉', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-tol-'))
    try {
      const cli = faithfulCli({ 'model.base_url': 'https://customer.example/api' })
      const breaking = {
        // 只有 base_url 的 unset 坏掉且键确实仍在 = 真实 CLI 故障；其余命令忠实模拟。
        run: async (command: string, args: readonly string[]): Promise<void> => {
          if (args[1] === 'unset' && args[2] === 'model.base_url') throw new Error('cli broken')
          return cli.run(command, args)
        },
        readKey: cli.readKey, settings: cli.settings
      }
      await expect(hermesAdapter(home, breaking).applyDeepSeek!(KEY)).rejects.toThrow('AI_ACCESS_HERMES_CONFIG_FAILED')
      expect(cli.settings.get('model.base_url')).toBe('https://customer.example/api')
      expect(cli.settings.get('model.provider')).toBeUndefined()
      expect(cli.settings.get('model.default')).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

const REAL_HERMES = join(process.env.HOME ?? '', '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes')

/** 与产品 runner 同纪律：非零退出即 reject。命令指向本机真实安装的 hermes。 */
function realHermesCli(sandboxHome: string) {
  const env = { HERMES_HOME: sandboxHome, HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb' }
  const run = async (_command: string, args: readonly string[]): Promise<void> => {
    await execFile(REAL_HERMES, [...args], { windowsHide: true, timeout: 15_000, maxBuffer: 1_024, env })
  }
  const readKey = async (_command: string, key: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execFile(REAL_HERMES, ['config', 'get', key], { windowsHide: true, timeout: 15_000, maxBuffer: 1_024, env })
      const value = stdout.trim()
      return value === '' ? undefined : value
    } catch { return undefined }
  }
  return { run, readKey }
}

describe.skipIf(!existsSync(REAL_HERMES))('真实 hermes CLI 集成', () => {
  it('直连启用在干净配置上成功（修复前必死于 unset model.base_url）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-real-'))
    try {
      const cli = realHermesCli(home)
      const adapters = createDeepSeekAdapters({
        home, platform: 'darwin', file: createManagedTextFile(),
        findHermesCommand: async () => REAL_HERMES,
        runHermes: cli.run, readHermesConfig: cli.readKey
      })
      const hermes = adapters.find(adapter => adapter.shell === 'hermes')
      if (hermes === undefined) throw new Error('hermes adapter missing')
      await hermes.applyDeepSeek!(KEY)
      const yaml = await readFile(join(home, 'config.yaml'), 'utf8')
      expect(yaml).toContain('provider: deepseek')
      expect(yaml).not.toContain('base_url')
      expect(yaml).not.toContain('api_key')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('unset 缺键确实以非零退出（钉住上游行为，防语义漂移）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-real-'))
    try {
      const { run } = realHermesCli(home)
      await expect(run(REAL_HERMES, ['config', 'unset', 'model.base_url'])).rejects.toThrow()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 60_000)

  it('完整生命周期：网关接管 → 解除回干净 → 再接管，全部走真实 CLI', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-real-'))
    try {
      const cli = realHermesCli(home)
      const adapters = createDeepSeekAdapters({
        home, platform: 'darwin', file: createManagedTextFile(),
        findHermesCommand: async () => REAL_HERMES,
        runHermes: cli.run, readHermesConfig: cli.readKey
      })
      const hermes = adapters.find(adapter => adapter.shell === 'hermes')
      if (hermes === undefined) throw new Error('hermes adapter missing')
      const readYaml = async (): Promise<string> => readFile(join(home, 'config.yaml'), 'utf8')

      // 接管：六个键全部写入真实 config.yaml，路由指向本机网关。
      const connection = { baseUrl: 'http://127.0.0.1:18085/hermes/deepseek/v1', apiKey: 'tb-gw-token-fixture-0123456789', model: 'deepseek-flash' }
      await hermes.applyConnection!('deepseek', connection)
      const takeover = await readYaml()
      expect(takeover).toContain('provider: custom')
      expect(takeover).toContain('base_url: http://127.0.0.1:18085/hermes/deepseek/v1')

      // 解除：六个键清空，客户配置回到干净形态。
      await hermes.deactivateToolboxConnection!()
      const deactivated = await readYaml()
      expect(deactivated).not.toContain('provider: custom')
      expect(deactivated).not.toContain('base_url:')

      // 再接管：解除后的干净配置必须能重新配上——「配得上也解得开也再配得上」。
      await hermes.applyConnection!('deepseek', connection)
      expect(await readYaml()).toContain('base_url: http://127.0.0.1:18085/hermes/deepseek/v1')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 180_000)
})
