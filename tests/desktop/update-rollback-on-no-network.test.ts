// 更新后连不上，自动退回上一版（0.5.0）。
//
// 客户感受那一条：更新完网络连不上时，工具箱自己退回上一版，而不是把他留在一个连不上的新版本上。
//
// 做法是**不另造回退机制**，而是把既有的那条路用满：更新助手换完 bundle 后本来就要等新版的
// 启动回执，等不到就用既有的两个 rename 把旧版换回来。缺的只是——回执现在只表示「起来了」，
// 不表示「连上了」。所以：更新前客户是连着的，回执就要等到真的连上；到点没连上，新版
// 记下「这一版别再自动装」然后**自己退出让台**，助手看见进程走了才动 bundle。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acknowledgeUpdate, readRejectedVersion, rejectedVersionPath, UPDATE_CONNECT_TIMEOUT_MS, type UpdateOutcome } from '../../app/main/desktop/updater'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function pending(options: { requireConnected?: boolean; version?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'toolbox-rollback-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const version = options.version ?? '0.5.0'
  await writeFile(join(directory, 'pending.json'), JSON.stringify({
    version, acknowledgement: join(directory, 'acknowledgement.json'), requireConnected: options.requireConnected === true
  }))
  return { directory, version, ack: join(directory, 'acknowledgement.json') }
}

/** 把等待压成即时:⛔ 让用例真的睡 60 秒。 */
function fastClock(outcomes: UpdateOutcome[]) {
  let clock = 0
  const giveUp = vi.fn()
  const deps = {
    outcome: () => outcomes.shift() ?? 'waiting',
    giveUp,
    timeoutMs: 2_000,
    pollMs: 100,
    now: () => clock,
    wait: async (ms: number) => { clock += ms }
  }
  return { deps, giveUp }
}

describe('更新后连不上自动退回', () => {
  it('更新前客户没连着：回执照旧立刻写，⛔ 多等一秒', async () => {
    const f = await pending({ requireConnected: false })
    const { deps, giveUp } = fastClock([])

    await acknowledgeUpdate(f.directory, f.version, deps)

    expect(JSON.parse(await readFile(f.ack, 'utf8'))).toMatchObject({ version: f.version })
    expect(giveUp).not.toHaveBeenCalled()
  })

  it('更新前连着：连上了才写回执', async () => {
    const f = await pending({ requireConnected: true })
    const { deps, giveUp } = fastClock(['waiting', 'waiting', 'connected'])

    await acknowledgeUpdate(f.directory, f.version, deps)

    expect(JSON.parse(await readFile(f.ack, 'utf8'))).toMatchObject({ version: f.version })
    expect(giveUp).not.toHaveBeenCalled()
    expect(await readRejectedVersion(f.directory)).toBeUndefined()
  })

  it('到点没连上：⛔ 写回执，记下这一版别再自动装，然后自己退出让台', async () => {
    const f = await pending({ requireConnected: true })
    const { deps, giveUp } = fastClock([]) // 一直 waiting

    await acknowledgeUpdate(f.directory, f.version, deps)

    // ⛔ 写回执 —— 写了助手就当更新成功，再不会回退
    expect(existsSync(f.ack)).toBe(false)
    expect(await readRejectedVersion(f.directory)).toEqual({ version: f.version })
    expect(giveUp).toHaveBeenCalledTimes(1) // 正向证据:确实让了台,⛔ 只是没写回执就干等着
  })

  it('客户自己点了断开：认这一版，⛔ 回退（那不是更新的锅）', async () => {
    const f = await pending({ requireConnected: true })
    const { deps, giveUp } = fastClock(['waiting', 'abandoned'])

    await acknowledgeUpdate(f.directory, f.version, deps)

    expect(JSON.parse(await readFile(f.ack, 'utf8'))).toMatchObject({ version: f.version })
    expect(giveUp).not.toHaveBeenCalled()
    expect(existsSync(rejectedVersionPath(f.directory))).toBe(false)
  })

  it('等待窗口要盖得住守护自己的退避梯子（2+10+30≈42 秒），⛔ 抢在它还在重试时就判死', () => {
    expect(UPDATE_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(42_000 + 10_000)
  })

  it('不是这一版的 pending：一个字都不动', async () => {
    const f = await pending({ requireConnected: true, version: '0.4.10' })
    const { deps, giveUp } = fastClock([])

    await acknowledgeUpdate(f.directory, '0.5.0', deps)

    expect(existsSync(f.ack)).toBe(false)
    expect(giveUp).not.toHaveBeenCalled()
    expect(existsSync(rejectedVersionPath(f.directory))).toBe(false)
  })
})

// 助手那一侧的两处：等回执的上限要随「更新前连着没有」变；失败分支要等新版真的退出。
describe('更新助手侧的配合', () => {
  it('回执等多久由任务带下来，⛔ 写死 45 秒', async () => {
    const helper = await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.cjs'), 'utf8')
    expect(helper).toContain('job.startupTimeoutMs')
    // 正向证据：没带这个字段时仍然是原来的 45 秒（客户本来没连着的更新一秒都不多等）
    expect(helper).toMatch(/job\.startupTimeoutMs\s*>\s*0\s*\?\s*job\.startupTimeoutMs\s*:\s*45_000/)
  })

  it('Windows 侧走同一套：等回执的上限随任务、失败分支等进程真的走掉', async () => {
    // 先前我误读过一次：看到 ps1 收到回执就删备份，就断定「Windows 没有回退材料」。
    // 实际上备份**正好活在确认窗口里**——回退要用的就是那一段，所以 Windows 不多占一个字节。
    const ps1 = await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.ps1'), 'utf8')
    expect(ps1).toContain('$job.startupTimeoutMs')
    // 闸按「有值且为正」判，⛔ 拿类型判：ConvertFrom-Json 的数字可能是 Int64，
    // 按 Int32 判会失败、悄悄退回 45 秒 —— 又是一个「没报错，只是没生效」。
    expect(ps1).toMatch(/\$null -ne \$job\.startupTimeoutMs -and \$job\.startupTimeoutMs -gt 0/)
    expect(ps1).toMatch(/\$startupMs = 45000/)            // 没带字段时照旧 45 秒
    expect(ps1).toMatch(/AddMilliseconds\(\$startupMs\)/)  // 带了就按任务给的等
    // 失败分支要等新版真的退出，⛔ 只看一眼 HasExited
    const holding = ps1.indexOf('$holding = $true')
    const loop = ps1.indexOf('Start-Sleep -Milliseconds 250', holding)
    expect(holding).toBeGreaterThan(-1)
    expect(loop).toBeGreaterThan(holding)
    // 「进程还活着就别搬目录」那条守卫 ⛔ 被顺手删掉
    expect(ps1).toContain('if ($holding) {')
    // 收到回执之前 ⛔ 删备份 —— 那是唯一的退路
    const ack = ps1.indexOf("throw 'UPDATE_STARTUP_UNCONFIRMED'")
    const removeBackup = ps1.indexOf('Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue')
    expect(ack).toBeLessThan(removeBackup)
  })

  it('失败分支要等新版真的走掉再动 bundle，⛔ 只看一眼就定', async () => {
    const helper = await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.cjs'), 'utf8')
    const guard = helper.indexOf('must not be moved underneath its process')
    const loop = helper.indexOf('do { running = await appRunning()', guard)
    expect(guard).toBeGreaterThan(-1)
    expect(loop).toBeGreaterThan(guard)
    // 「进程还活着就别搬」那条守卫本身 ⛔ 被顺手删掉——它挡的是把 bundle 从跑着的进程底下搬走
    expect(helper).toMatch(/if \(running\) \{/)
  })
})

// 防循环：被退回来的那一版 ⛔ 再自动装一次。否则客户陷在「装上 → 连不上 → 退回 → 再装」里，
// 而且他会自己发现版本号退回去了——不说，他不会以为「工具箱保护了我」，只会以为更新坏了。
describe('被退回来的版本不再自动装', () => {
  it('检查更新时跳过它，并如实告诉客户发生了什么', async () => {
    const { createHash, generateKeyPairSync, sign } = await import('node:crypto')
    const { ToolboxUpdater } = await import('../../app/main/desktop/updater')
    const keys = generateKeyPairSync('ed25519')
    const content = Buffer.from('package')
    const release = {
      version: '0.5.0', notes: '网络加强',
      assets: { 'darwin-arm64': { url: 'https://updates.example/AI-tools/updates/toolbox.zip', size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'), asarSha256: 'a'.repeat(64) } }
    }
    const payload = Buffer.from(JSON.stringify(release))
    const envelope = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })
    const directory = await mkdtemp(join(tmpdir(), 'toolbox-rejected-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const options = {
      version: '0.4.10', platform: 'darwin-arm64', origin: 'https://updates.example/AI-tools/',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), directory,
      executable: '/Applications/x.app/Contents/MacOS/x', helperPath: '/x', packaged: true, quit: () => undefined,
      fetch: (async () => new Response(envelope, { status: 200 })) as unknown as typeof fetch
    }

    // 正向证据：没有 rejected 记录时，这一版是正常的「发现新版」
    expect(await new ToolboxUpdater(options).check()).toMatchObject({ state: 'available', version: '0.5.0' })

    await writeFile(rejectedVersionPath(directory), JSON.stringify({ version: '0.5.0' }))
    const after = await new ToolboxUpdater(options).check()

    expect(after.state).not.toBe('available')
    expect(after.message).toContain('无法连接')
    expect(after.message).toContain('已自动还原')
  })
})

// 「这一轮算不算成」的判据本身：⛔ 用 supervisor 的 surrendered（它只管守护起没起来，
// 而「起来了连不上」压根不经过它——那正是更新后最可能的失败）。
describe('算不算成的判据', () => {
  it('已连=成；用户主动断开/未配置=不是更新的锅；其余一律继续等', async () => {
    const { initializeTunnelRuntime, updateConnectOutcome } = await import('../../app/main/tunnel/runtime-owner')
    let state = '已连'
    initializeTunnelRuntime(() => ({ status: () => ({ state }) }) as never)

    expect(updateConnectOutcome()).toBe('connected')
    for (const abandoned of ['用户主动断开', '未配置']) { state = abandoned; expect(updateConnectOutcome()).toBe('abandoned') }
    // 坏版本会停在这几个地方，⛔ 当成「客户不要连了」放过去
    for (const waiting of ['连接中', '通道待确认', '异常', '已停止并恢复原设置']) { state = waiting; expect(updateConnectOutcome()).toBe('waiting') }
  })
})
