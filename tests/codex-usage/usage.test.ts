import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { codexAccountKey, normalizeBuckets, maskAccount } from '../../app/main/codex-usage/normalize'
import { readCodexUsage, UsageReadError } from '../../app/main/codex-usage/client'
import { findCodexCommand } from '../../app/main/codex-usage/runtime'
import { createUsageMonitor } from '../../app/main/codex-usage/monitor'
import { percentText, resetText, windowLabel } from '../../app/renderer/src/codex-usage/view'

const fixture = resolve('tests/codex-usage/fixtures/server.mjs')
const account = { type: 'chatgpt', email: 'demo@example.test', planType: 'plus' }
const limits = { rateLimits: { primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 2_100_000_000 } } }

describe('Codex 用量口径', () => {
  it('优先分组额度并换算剩余，缺失字段不变成零', () => {
    const buckets = normalizeBuckets({ ...limits, rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 37.5, windowDurationMins: 300, resetsAt: 2_100_000_000 }, secondary: null },
      model: { limitName: 'Additional', primary: { usedPercent: null }, secondary: { usedPercent: 0, windowDurationMins: 10080 } }
    } })
    expect(buckets).toHaveLength(2)
    expect(buckets[0].primary?.remainingPercent).toBe(62.5)
    expect(buckets[0].secondary).toBeNull()
    expect(buckets[1].primary?.remainingPercent).toBeNull()
    expect(buckets[1].secondary?.remainingPercent).toBe(100)
    expect(windowLabel(buckets[1].secondary, 'unknown')).toBe('每周额度')
  })
  it('兼容旧格式，非法值未知、超过上限封顶、不猜窗口或余额', () => {
    const [bucket] = normalizeBuckets({ rateLimits: { primary: { usedPercent: 150, windowDurationMins: 0, resetsAt: -1 }, secondary: { usedPercent: '30' }, credits: { unlimited: false, balance: 'not-a-number' } } })
    expect(bucket.primary).toEqual({ usedPercent: 100, remainingPercent: 0, windowDurationMins: null, resetsAt: null })
    expect(bucket.secondary?.usedPercent).toBeNull()
    expect(bucket.credits?.balance).toBeNull()
    expect(normalizeBuckets(null)).toEqual([])
    expect(normalizeBuckets({ rateLimitsByLimitId: { invalid: null } })).toEqual([])
  })
  it('不同周期按返回值命名，到重置时间不自行声称额度已恢复', () => {
    const window = normalizeBuckets({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 15 } } })[0].primary
    expect(windowLabel(window, '未知')).toBe('15 分钟额度')
    expect(resetText(1, 2_000)).toContain('等待刷新确认')
    expect(percentText(null)).toBe('未知')
    expect(maskAccount(account.email)).toBe('de***@example.test')
    expect(maskAccount(null)).toBe('当前 ChatGPT 账号')
  })
})

describe('实际子进程协议', () => {
  it('完整初始化、读取账号与额度、再核对账号，仅允许只读方法', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'usage-protocol-'))
    try {
      const requests = join(directory, 'requests.jsonl')
      const result = await readCodexUsage({ executable: process.execPath, args: [fixture] }, { cwd: directory, signal: new AbortController().signal, env: { ...process.env, USAGE_FIXTURE_REQUESTS: requests } })
      expect(result.account.email).toBe(account.email)
      expect(normalizeBuckets(result.limits)[0].primary?.remainingPercent).toBe(73)
      const calls = (await readFile(requests, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method: string; params?: { refreshToken: boolean } })
      expect(calls.map((call) => call.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read'])
      expect(calls.filter((call) => call.method === 'account/read').every((call) => call.params?.refreshToken === false)).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it.each([
    ['signed-out', 'signed-out'], ['api-key', 'unsupported'], ['changed', 'account-changed'],
    ['failure', 'unavailable'], ['exit', 'unavailable'], ['malformed', 'unavailable'], ['oversize', 'unavailable'], ['unsupported-method', 'update-required']
  ])('处理 %s，原始错误不外泄', async (mode, status) => {
    await expect(readCodexUsage({ executable: process.execPath, args: [fixture, mode] }, { cwd: tmpdir(), signal: new AbortController().signal })).rejects.toEqual(new UsageReadError(status as UsageReadError['status']))
  })
  it('超时后回收拒绝退出的子进程', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'usage-timeout-'))
    try {
      const pidFile = join(directory, 'pid')
      await expect(readCodexUsage({ executable: process.execPath, args: [fixture, 'ignore-term'] }, {
        cwd: directory, signal: new AbortController().signal, timeoutMs: 250, env: { ...process.env, USAGE_FIXTURE_PID: pidFile }
      })).rejects.toMatchObject({ status: 'timeout' })
      const pid = Number(await readFile(pidFile, 'utf8'))
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2500 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('取消与启动失败能结束请求', async () => {
    const controller = new AbortController()
    const pending = readCodexUsage({ executable: process.execPath, args: [fixture, 'hang'] }, { cwd: tmpdir(), signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ status: 'unavailable' })
    await expect(readCodexUsage({ executable: '/missing-codex', args: [] }, { cwd: tmpdir(), signal: new AbortController().signal })).rejects.toMatchObject({ status: 'unavailable' })
  })
})

describe('刷新与账号生命周期', () => {
  it('登录不同账号后绕过旧缓存；查询过程中换号不回传其他人的额度', async () => {
    let current = account
    const monitor = createUsageMonitor(async () => ({ account: current, limits }))
    await monitor.refresh(codexAccountKey(account))
    current = { ...account, email: 'other@example.test' }
    expect((await monitor.refresh(codexAccountKey(current))).snapshot?.accountLabel).toBe('ot***@example.test')
    expect(await monitor.refresh(codexAccountKey(account))).toMatchObject({ status: 'account-changed', snapshot: null })
    monitor.dispose()
  })
  it('并发合并、30 秒冷却，只有清洗后的额度进入界面', async () => {
    let clock = 1_000
    const read = vi.fn(async () => ({ account: { ...account, token: 'fixture-secret' }, limits }))
    const monitor = createUsageMonitor(read, () => clock)
    const [first, second] = await Promise.all([monitor.refresh(), monitor.refresh()])
    expect(first).toEqual(second)
    expect(read).toHaveBeenCalledTimes(1)
    await monitor.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(first)).not.toContain('fixture-secret')
    expect(JSON.stringify(first)).not.toContain(account.email)
    clock += 30_001
    await monitor.refresh()
    expect(read).toHaveBeenCalledTimes(2)
    monitor.dispose()
  })
  it('登出、失败和换号均不能沿用旧账号额度，恢复后能读新账号', async () => {
    let clock = 0
    const read = vi.fn().mockResolvedValueOnce({ account, limits })
      .mockRejectedValueOnce(new UsageReadError('signed-out'))
      .mockResolvedValueOnce({ account: { ...account, email: 'other@example.test' }, limits })
      .mockRejectedValueOnce(new Error('fixture-secret'))
    const monitor = createUsageMonitor(read, () => clock)
    expect((await monitor.refresh()).status).toBe('ready')
    clock += 30_001
    expect(await monitor.refresh()).toMatchObject({ status: 'signed-out', snapshot: null })
    clock += 30_001
    expect((await monitor.refresh()).snapshot?.accountLabel).toBe('ot***@example.test')
    clock += 30_001
    expect(await monitor.refresh()).toMatchObject({ status: 'unavailable', snapshot: null })
  })
  it('退出中止请求，晚到结果不恢复缓存', async () => {
    let done!: (data: { account: typeof account; limits: typeof limits }) => void
    let signal!: AbortSignal
    const monitor = createUsageMonitor((value) => { signal = value; return new Promise((resolve) => { done = resolve }) })
    const pending = monitor.refresh()
    monitor.dispose()
    expect(signal.aborted).toBe(true)
    done({ account, limits })
    await pending
    expect(monitor.last().snapshot).toBeNull()
  })
})

describe('本机 Codex 发现', () => {
  it('固定 npm 全局目录中的官方原生文件可用，不通过 cmd、shell 或 PATH launcher', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'usage-npm-')))
    try {
      const bin = join(directory, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 'x86_64-unknown-linux-musl', 'bin')
      await mkdir(bin, { recursive: true })
      await writeFile(join(bin, 'codex'), Buffer.from('7f454c46', 'hex'))
      expect(await findCodexCommand(directory, 'linux', { PATH: directory }, 'x64')).toEqual({ executable: join(bin, 'codex'), args: ['app-server', '--listen', 'stdio://'] })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('忽略 PATH 包装器和伪造原生文件，不修改或执行其中命令', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'usage-runtime-'))
    try {
      await writeFile(join(directory, 'codex'), '#!/bin/sh\nexit 1\n')
      await chmod(join(directory, 'codex'), 0o755)
      expect(await findCodexCommand(directory, 'linux', { PATH: `.:${directory}` })).toBeNull()
      await writeFile(join(directory, 'codex'), Buffer.from('7f454c46', 'hex'))
      expect(await findCodexCommand(directory, 'linux', { PATH: directory })).toBeNull()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
