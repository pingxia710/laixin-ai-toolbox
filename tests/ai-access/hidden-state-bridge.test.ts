import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// 这个模块不碰 electron，类型静态引进来就行（编译期抹掉，⛔ 影响下面的 vi.mock）。
import type { HiddenStateReport } from '../../app/main/ai-access/hidden-state'
import type { HiddenStateCleanReceipt } from '../../app/main/actions/hidden-state'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(tmpdir(), `laixin-hidden-state-fixture-${name}`) },
  ipcRenderer: { invoke: (...args: unknown[]) => Promise.resolve({ snapshot: JSON.stringify(args) }) }
}))

const { BridgeRegistry } = await import('../../app/main/bridge/bridge-registry')
const actions = await import('../../app/main/actions/hidden-state')
const preload = await import('../../app/preload/api/hidden-state')
const { registerActions, registerHiddenStateActions } = actions
type Receipt = HiddenStateCleanReceipt
type Report = HiddenStateReport

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'laixin-hidden-bridge-'))
  roots.push(home)
  await writeFile(join(home, '.zshrc'), 'export OPENAI_API_KEY=sk-openai-0123456789abcdef\n', 'utf8')
  await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }), 'utf8')
  const registry = new BridgeRegistry()
  registerHiddenStateActions(registry, {
    platform: 'darwin', home, env: {}, backupDir: join(home, 'backups'),
    readSystemProxy: async () => null, now: () => new Date('2026-09-13T19:05:01')
  })
  return { home, registry }
}
const call = async <T,>(registry: InstanceType<typeof BridgeRegistry>, name: string, params: unknown): Promise<T> =>
  JSON.parse(((await registry.execute(name, params)) as { snapshot: string }).snapshot) as T

describe('隐形状态的桥入口', () => {
  it('三个动作都在，扫描结果原样过桥', async () => {
    const f = await fixture()
    const report = await call<Report>(f.registry, 'aiaccess.hiddenState.scan', undefined)
    expect(report.findings.map((item) => item.name)).toEqual(['OPENAI_API_KEY'])
    expect(report.platform).toBe('darwin')
  })

  it('清理 → 撤销走一圈，文件回到原样', async () => {
    const f = await fixture()
    const path = join(f.home, '.zshrc')
    const original = await readFile(path, 'utf8')
    const report = await call<Report>(f.registry, 'aiaccess.hiddenState.scan', undefined)

    const receipt = await call<Receipt>(f.registry, 'aiaccess.hiddenState.clean', { ids: JSON.stringify([report.findings[0].id]) })
    expect(receipt.cleaned).toBe(1)
    expect(JSON.stringify(receipt)).not.toContain('sk-openai-0123456789abcdef')
    expect(receipt.shell.entries[0]).not.toHaveProperty('originalLine')
    expect(await readFile(path, 'utf8')).not.toBe(original)
    expect(await readFile(path, 'utf8')).toContain('来信AI工具箱 2026-09-13 停用')

    const outcome = await call<{ results: { outcome: string }[] }>(f.registry, 'aiaccess.hiddenState.restore', { receipt: JSON.stringify(receipt) })
    expect(outcome.results.map((item) => item.outcome)).toEqual(['restored'])
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('ids 传空串＝这次能处理的全处理', async () => {
    const f = await fixture()
    await writeFile(join(f.home, '.bashrc'), 'export KIMI_API_KEY=sk-kimi-0123456789abcdef\n', 'utf8')
    const receipt = await call<Receipt>(f.registry, 'aiaccess.hiddenState.clean', { ids: '' })
    expect(receipt.cleaned).toBe(2)
  })

  it('传了 ids 就只处理这几条，别的一个字不动', async () => {
    const f = await fixture()
    const other = join(f.home, '.bashrc')
    const untouched = 'export KIMI_API_KEY=sk-kimi-0123456789abcdef\n'
    await writeFile(other, untouched, 'utf8')
    const report = await call<Report>(f.registry, 'aiaccess.hiddenState.scan', undefined)
    const target = report.findings.find((item) => item.name === 'OPENAI_API_KEY')!

    const receipt = await call<Receipt>(f.registry, 'aiaccess.hiddenState.clean', { ids: JSON.stringify([target.id]) })
    expect(receipt.cleaned).toBe(1)
    expect(receipt.shell.entries.map((entry) => entry.name)).toEqual(['OPENAI_API_KEY'])
    expect(await readFile(other, 'utf8')).toBe(untouched)
  })

  it('清理前会重扫：中间客户自己改过，就按新的来 ⛔ 按旧的蒙着改', async () => {
    const f = await fixture()
    const report = await call<Report>(f.registry, 'aiaccess.hiddenState.scan', undefined)
    const rewritten = 'export SOMETHING_ELSE=1\n'
    await writeFile(join(f.home, '.zshrc'), rewritten, 'utf8')
    const receipt = await call<Receipt>(f.registry, 'aiaccess.hiddenState.clean', { ids: JSON.stringify([report.findings[0].id]) })
    expect(receipt.cleaned).toBe(0)
    expect(await readFile(join(f.home, '.zshrc'), 'utf8')).toBe(rewritten)
  })

  it('参数形状不对一律拒，⛔ 让乱七八糟的东西进到文件操作里', async () => {
    const f = await fixture()
    await expect(f.registry.execute('aiaccess.hiddenState.clean', { ids: ['a'] })).rejects.toThrow('ACTION_PARAMS_INVALID')
    await expect(f.registry.execute('aiaccess.hiddenState.scan', { anything: 'x' })).rejects.toThrow('ACTION_PARAMS_INVALID')
    await expect(f.registry.execute('aiaccess.hiddenState.clean', { ids: '{"not":"array"}' })).rejects.toThrow('ACTION_FAILED')
    await expect(f.registry.execute('aiaccess.hiddenState.restore', { receipt: '{"version":9}' })).rejects.toThrow('ACTION_FAILED')
    await expect(f.registry.execute('aiaccess.hiddenState.restore', { receipt: JSON.stringify({ version: 1, receiptId: '9aefb2d8-4d73-4e30-b267-84e6f517de4a' }) })).rejects.toThrow('ACTION_FAILED')
  })

  it('动作自动发现拿得到它：导出 registerActions，⛔ 需要改 index', () => {
    expect(typeof registerActions).toBe('function')
    const registry = new BridgeRegistry()
    expect(() => registerActions(registry)).not.toThrow()
    // 同一个 registry 再注册一次要被挡住，说明名字确实登记进去了。
    expect(() => registerActions(registry)).toThrow('ACTION_ALREADY_REGISTERED')
  })
})

describe('隐形状态的 preload 入口', () => {
  it('满足 preload 自动收集的约定：命名空间小写、api 是对象', () => {
    expect(preload.namespace).toMatch(/^[a-z][a-z0-9]*$/)
    expect(typeof preload.api).toBe('object')
    expect(Object.keys(preload.api).sort()).toEqual(['clean', 'restore', 'scan'])
  })

  it('数组在 preload 这层转成 JSON，⛔ 让界面自己拼', async () => {
    const calls: [string, unknown][] = []
    const api = preload.createHiddenStateApi(async (name, params) => { calls.push([name, params]); return { snapshot: '{}' } })
    await api.scan()
    await api.clean({ ids: ['a', 'b'] })
    await api.restore({ receipt: '{}' })
    expect(calls).toEqual([
      ['aiaccess.hiddenState.scan', undefined],
      ['aiaccess.hiddenState.clean', { ids: '["a","b"]' }],
      ['aiaccess.hiddenState.restore', { receipt: '{}' }]
    ])
  })
})
