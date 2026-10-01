// FB-1(反馈可归因):客户连不上时,我们这边说得出是哪一类原因。
// 客户端已有 39 个失败码,但全部留在客户机器上;本文件守住「失败终态按白名单回传」这条链:
//  · 只传 失败码/失败阶段/平台/客户端版本/授权 ID/时间戳 —— ⛔ IP、地址、进程名、配置内容、任何文本
//  · 判不出原因记 UNKNOWN + 阶段,⛔ 硬塞进最接近的已知码(那等于把「不知道」伪装成「知道」)
//  · 关掉开关一条都不传(直传与入队都断);后台不可达本地攒(上限 50 条、7 天),下次启动补传
//  · 并发噪音(互斥忙)与重试过程不算失败终态,⛔ 刷屏
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { NetworkAccountError } from '../../app/main/tunnel/account-client'
import { DIAGNOSIS_QUEUE_LIMIT, DiagnosisReporter } from '../../app/main/tunnel/diagnosis-reporter'
import type { DiagnosisPayload } from '../../app/main/tunnel/diagnosis-reporter'
import { loadTrustContext } from '../../app/main/tunnel/trust'
import { makeTempDir, removeTempDir } from './helpers'
import type { EncryptedQueueCodec } from '../../app/main/tunnel/diagnostic-event-queue'

const identityQueueCodec: EncryptedQueueCodec = {
  encrypt: (plain) => Buffer.from(plain, 'utf8'),
  decrypt: (encrypted) => encrypted.toString('utf8')
}

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(removeTempDir) })

function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix)
  dirs.push(dir)
  return dir
}

// 已导入配置的最小现场:manifest + 指针(真实导入走完整包校验,这里只喂 readCurrentInfo)。
function seedImported(dataDir: string): string {
  const batchId = '20260915010000-cafebabe'
  const batchDir = join(dataDir, 'imports', batchId)
  mkdirSync(batchDir, { recursive: true })
  writeFileSync(join(batchDir, 'manifest.json'), JSON.stringify({
    protocol: 'vless-reality', configVersion: 1, authorizationId: `lx-${'a'.repeat(32)}`,
    node: { host: 'node.test.invalid', port: 443 }, expiresAt: '2027-01-01T00:00:00.000Z',
    files: { 'credentials/vless.json': {} }
  }))
  writeFileSync(join(batchDir, 'import-meta.json'), JSON.stringify({ accountId: 'customer-a', sourceLine: 'vless://fixture' }))
  writeFileSync(join(dataDir, 'current'), `${batchId}\n`)
  return batchId
}

// 守护终态由守护写进 state.json;主进程经 rawStatus 读到(守护怎么写已被 authorization-expiry 等用例守住)。
function seedDaemonState(dataDir: string, state: Record<string, unknown>): void {
  const intent = JSON.parse(readFileSync(join(dataDir, 'intent.json'), 'utf8')) as { sessionToken?: string }
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'run-fixture', intentToken: intent.sessionToken, ...state }))
}

interface ServiceHandle {
  tunnel: TunnelService
  dataDir: string
  sent: DiagnosisPayload[]
  queuePath: string
  failNextSendWith: (error?: Error) => void
  setEnabled: (enabled: boolean) => void
}

function service(input: { imported?: boolean; connected?: boolean; residentAlive?: () => boolean; now?: () => number } = {}): ServiceHandle {
  const dataDir = tempDir('laixin-diagnosis-')
  if (input.imported) seedImported(dataDir)
  const queuePath = join(dataDir, 'diagnosis-pending.json')
  const sent: DiagnosisPayload[] = []
  let enabled = true
  let sendError: Error | undefined
  const tunnel = new TunnelService({
    dataDir,
    sidecarDir: input.imported ? tempDir('laixin-sidecar-empty-') : tempDir('laixin-sidecar-missing-'),
    trust: loadTrustContext({}, {}),
    now: input.now ?? (() => Date.now()),
    picker: async () => undefined,
    spawnDaemon: () => ({ on: () => undefined }),
    spawnRestore: () => undefined,
    routesFile: join(dataDir, 'routes.default.json'),
    ...(input.connected ? { resident: {
      armed: () => true, alive: input.residentAlive ?? (() => true), wake: async () => true, seatRunId: () => 'run-fixture'
    } } : {}),
    diagnosis: {
      enabled: () => enabled,
      version: () => '9.9.9-test',
      queueCodec: identityQueueCodec,
      send: async (payload) => {
        if (sendError) { const error = sendError; sendError = undefined; throw error }
        sent.push(payload)
      }
    }
  })
  if (input.connected) {
    writeFileSync(join(dataDir, 'intent.json'), JSON.stringify({ desired: 'connected', sessionToken: 'connected-fixture' }))
    seedDaemonState(dataDir, { state: 'connected', intentToken: 'connected-fixture', exitIp: '203.0.113.10', lastVerifiedAt: Date.now() })
  }
  return {
    tunnel, dataDir, sent, queuePath,
    failNextSendWith: (error) => { sendError = error ?? new Error('NETWORK_SERVICE_UNAVAILABLE') },
    setEnabled: (value) => { enabled = value }
  }
}

const deniedAccess = {
  client: { claim: async () => { throw new NetworkAccountError('NETWORK_AUTHORIZATION_UNAVAILABLE') } },
  session: { accountId: 'customer-a', accessToken: 'token', deviceId: 'device-fixture' }
}

it('主进程报告来源读取实际 spawn 回调的 runId 与时间，不经过上报字段', () => {
  const spawnedAt = Date.now() - 1_000
  const f = service({ now: () => spawnedAt })
  expect(f.tunnel.reportRuntimeProvenance()).toEqual({ residentOnlyRunning: false, restoring: false })
  const supervisor = (f.tunnel as unknown as { supervisor: { ensureRunning: () => void } }).supervisor
  supervisor.ensureRunning()
  expect(f.tunnel.reportRuntimeProvenance()).toMatchObject({
    spawnRunId: expect.any(String), lastSpawnAt: spawnedAt, residentOnlyRunning: false, restoring: false
  })
  expect(f.sent).toHaveLength(0)
})

describe('失败终态回传 · 客户端挂钩', () => {
  it('发起即失败(组件缺失)回传该码,阶段 connect-start', async () => {
    const f = service()
    const result = await f.tunnel.start()
    expect(result.outcome).toBe('rejected')
    expect(result.code).toBe('TUNNEL_COMPONENT_MISSING')
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    expect(f.sent[0]).toEqual({
      code: 'TUNNEL_COMPONENT_MISSING', stage: 'connect-start', platform: 'macos',
      clientVersion: '9.9.9-test', authorizationId: '', timestamp: expect.any(Number)
    })
  })

  it('权益到期(后台明确拒绝)回传 NETWORK_AUTHORIZATION_UNAVAILABLE;授权 ID 随报告带上', async () => {
    const f = service({ imported: true })
    await f.tunnel.setAccountAccess(deniedAccess as never)
    const result = await f.tunnel.start()
    expect(result.code).toBe('NETWORK_AUTHORIZATION_UNAVAILABLE')
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    expect(f.sent[0]).toMatchObject({ code: 'NETWORK_AUTHORIZATION_UNAVAILABLE', stage: 'connect-start', authorizationId: `lx-${'a'.repeat(32)}` })
    expect(f.sent).toHaveLength(1) // 显式点连接失败不能再记一笔运行中自主暂停
  })

  it('原本已连、后台明确拒绝后自主暂停：客户能看到原因，六字段 connect-run 恰好一笔', async () => {
    const f = service({ imported: true, connected: true })
    expect(f.tunnel.status().state).toBe('已连')

    const denied = await f.tunnel.setAccountAccess(deniedAccess as never)
    expect(denied.code).toBe('NETWORK_AUTHORIZATION_UNAVAILABLE')
    const intent = JSON.parse(readFileSync(join(f.dataDir, 'intent.json'), 'utf8')) as { desired: string; reason: string; sessionToken: string }
    expect(intent).toMatchObject({ desired: 'user-disconnected', reason: 'entitlement-denied' })
    expect(f.tunnel.explicitlyStoppedNetwork()).toBe(false)
    expect(f.tunnel.status()).toMatchObject({
      state: '断开中', pauseReason: 'entitlement-denied', exitIp: '', pathSource: '',
      message: expect.stringContaining('恢复尚未确认')
    }) // 守护尚未回写时，旧 connected 不能继续冒充本次网络可用
    expect((await f.tunnel.syncAccountConfig())).toMatchObject({ outcome: 'rejected', code: 'TUNNEL_BUSY' })
    expect((await f.tunnel.start())).toMatchObject({ outcome: 'rejected', code: 'TUNNEL_BUSY' })
    expect(JSON.parse(readFileSync(join(f.dataDir, 'intent.json'), 'utf8')).sessionToken).toBe(intent.sessionToken)
    seedDaemonState(f.dataDir, { state: 'stopped-restored', intentToken: 'connected-fixture' })
    expect(f.tunnel.status()).toMatchObject({
      state: '断开中', pauseReason: 'entitlement-denied',
      message: expect.stringContaining('恢复尚未确认')
    }) // 上一轮的完成状态不能证明这次断开已经恢复
    seedDaemonState(f.dataDir, { state: 'stopped-restored', intentToken: intent.sessionToken })
    expect(f.tunnel.status()).toMatchObject({
      state: '已停止并恢复原设置', pauseReason: 'entitlement-denied',
      message: expect.stringContaining('权益校验未通过')
    })
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    expect(f.sent[0]).toEqual({
      code: 'NETWORK_AUTHORIZATION_UNAVAILABLE', stage: 'connect-run', platform: 'macos',
      clientVersion: '9.9.9-test', authorizationId: `lx-${'a'.repeat(32)}`, timestamp: expect.any(Number)
    })
    f.tunnel.status()
    f.tunnel.status()
    await f.tunnel.syncAccountConfig()
    expect(f.sent).toHaveLength(1)
    expect(f.tunnel.status().pauseReason).toBe('entitlement-denied')
    expect(JSON.parse(readFileSync(join(f.dataDir, 'intent.json'), 'utf8')).sessionToken).toBe(intent.sessionToken)
    await f.tunnel.stop()
    expect(f.tunnel.status().pauseReason).toBe('') // 后续用户操作覆盖本次受控原因
    expect(f.tunnel.explicitlyStoppedNetwork()).toBe(true)
    writeFileSync(join(f.dataDir, 'intent.json'), JSON.stringify({ desired: 'connected', sessionToken: 'new-connection' }))
    seedDaemonState(f.dataDir, { state: 'connected', intentToken: 'new-connection' })
    expect(f.tunnel.status().pauseReason).toBe('') // 新连接不能继承上次暂停的提示
  })

  it('用户先断开、后台暂时失败、自动回传关闭，都不能误报自主暂停', async () => {
    const stopped = service({ imported: true, connected: true })
    await stopped.tunnel.stop()
    await stopped.tunnel.setAccountAccess(deniedAccess as never)
    expect(stopped.sent).toHaveLength(0)
    expect(stopped.tunnel.status().pauseReason).toBe('')

    const transient = service({ imported: true, connected: true })
    const temporaryAccess = { ...deniedAccess, client: { claim: async () => { throw new NetworkAccountError('NETWORK_SERVICE_UNAVAILABLE') } } }
    expect((await transient.tunnel.setAccountAccess(temporaryAccess as never)).outcome).toBe('continued')
    expect(transient.sent).toHaveLength(0)
    expect(transient.tunnel.status().pauseReason).toBe('')

    const disabled = service({ imported: true, connected: true })
    disabled.setEnabled(false)
    await disabled.tunnel.setAccountAccess(deniedAccess as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(disabled.sent).toHaveLength(0)
    expect(existsSync(disabled.queuePath)).toBe(false)
  })

  it('权益暂停时常驻守护退出且无待还账，不永久卡断开中', async () => {
    let alive = true
    const f = service({ imported: true, connected: true, residentAlive: () => alive })
    await f.tunnel.setAccountAccess(deniedAccess as never)
    expect(f.tunnel.status().state).toBe('断开中')
    alive = false
    expect(f.tunnel.status()).toMatchObject({ state: '用户主动断开', pauseReason: 'entitlement-denied',
      message: expect.stringContaining('守护未在运行') })
    expect((await f.tunnel.syncAccountConfig()).code).toBe('NETWORK_AUTHORIZATION_UNAVAILABLE')
  })

  it('权益拒绝后守护超时不确认，仍显示拒绝原因和未确认恢复', async () => {
    let clock = Date.now()
    const f = service({ imported: true, connected: true, now: () => clock })
    await f.tunnel.setAccountAccess(deniedAccess as never)
    expect(f.tunnel.status().pauseReason).toBe('entitlement-denied')
    clock += 46_000
    expect(f.tunnel.status()).toMatchObject({ state: '异常', pauseReason: 'entitlement-denied',
      message: expect.stringContaining('权益校验未通过') })
    expect(f.tunnel.status().message).toContain('恢复尚未确认')
  })

  it('原连接仍在但通道待确认时后台明确拒绝，也算一次运行中自主暂停', async () => {
    const f = service({ imported: true, connected: true })
    seedDaemonState(f.dataDir, { state: 'degraded', intentToken: 'connected-fixture' })
    expect(f.tunnel.status().state).toBe('通道待确认')
    await f.tunnel.setAccountAccess(deniedAccess as never)
    const intent = JSON.parse(readFileSync(join(f.dataDir, 'intent.json'), 'utf8')) as { autoPauseCode?: string; sessionToken: string }
    expect(intent.autoPauseCode).toBe('NETWORK_AUTHORIZATION_UNAVAILABLE')
    seedDaemonState(f.dataDir, { state: 'stopped-restored', intentToken: intent.sessionToken })
    expect(f.tunnel.status().pauseReason).toBe('entitlement-denied')
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    expect(f.sent[0]).toMatchObject({ code: 'NETWORK_AUTHORIZATION_UNAVAILABLE', stage: 'connect-run' })
  })

  it('后台核验在途时用户点断开：迟到的拒绝不冒充自主暂停', async () => {
    const f = service({ imported: true, connected: true })
    let rejectClaim: ((error: Error) => void) | undefined
    let claimSignal: AbortSignal | undefined
    const access = { ...deniedAccess, client: { claim: async (_session: unknown, signal: AbortSignal) => {
      claimSignal = signal
      return new Promise<never>((_resolve, reject) => { rejectClaim = reject })
    } } }
    const syncing = f.tunnel.setAccountAccess(access as never)
    await vi.waitFor(() => expect(rejectClaim).toBeTypeOf('function'))
    const stopping = f.tunnel.stop()
    await vi.waitFor(() => expect(claimSignal?.aborted).toBe(true))
    rejectClaim!(new NetworkAccountError('NETWORK_AUTHORIZATION_UNAVAILABLE'))
    await syncing
    await stopping
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.sent).toHaveLength(0)
    expect(JSON.parse(readFileSync(join(f.dataDir, 'intent.json'), 'utf8'))).toMatchObject({ reason: 'user-stop' })
    expect(f.tunnel.status().pauseReason).toBe('')
  })

  it('FB-3 件一:守护 state 被写进机器文本(带路径的 Node 错误)⛔ 原样上传,出口归 UNKNOWN', async () => {
    // 现场形态:底层 Node 错误文本进了守护 state.json 的 code(异常路径/旧版本/文件损坏都可能)。
    // 无空格的路径能通过后台字符集闸——所以必须在客户端出口收口:不是受控码就归 UNKNOWN,
    // 真实文本留在本机日志,⛔ 上传冒充「已知原因」。
    const dataDir = tempDir('laixin-diagnosis-')
    seedImported(dataDir)
    const sent: DiagnosisPayload[] = []
    const tunnel = new TunnelService({
      dataDir, sidecarDir: tempDir('laixin-sidecar-empty-'), trust: loadTrustContext({}, {}), now: () => Date.now(),
      picker: async () => undefined, spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
      routesFile: join(dataDir, 'routes.default.json'),
      diagnosis: { enabled: () => true, version: () => '9.9.9-test', send: async (payload) => { sent.push(payload) } }
    })
    const machineText = "ENOENT:open'/Users/laixin/config.json'"
    seedDaemonState(dataDir, { state: 'error', code: machineText, message: machineText })
    tunnel.status()
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].code).toBe('UNKNOWN')
    expect(JSON.stringify(sent[0])).not.toContain('/Users/laixin')
  })
})

describe('失败终态回传 · 守护终态与 UNKNOWN', () => {
  it.each(['TUNNEL_PROXY_INSPECTION_FAILED', 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN'])(
    'N-44 离线代理故障 %s 保留精确码进入六字段自动回传', async (code) => {
      const dataDir = tempDir('laixin-n44-diagnosis-')
      seedImported(dataDir)
      const sent: DiagnosisPayload[] = []
      const tunnel = new TunnelService({
        dataDir, sidecarDir: tempDir('laixin-sidecar-empty-'), trust: loadTrustContext({}, {}), now: () => Date.now(),
        picker: async () => undefined, spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
        routesFile: join(dataDir, 'routes.default.json'),
        diagnosis: { enabled: () => true, version: () => '9.9.9-test', send: async (payload) => { sent.push(payload) } }
      })
      seedDaemonState(dataDir, { state: 'error', code, message: '原始诊断不可外传' })
      tunnel.status()
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      expect(sent[0]).toMatchObject({ code, stage: 'connect-run', authorizationId: `lx-${'a'.repeat(32)}` })
      expect(Object.keys(sent[0]).sort()).toEqual(['authorizationId', 'clientVersion', 'code', 'platform', 'stage', 'timestamp'])
    }
  )

  it('守护 error 带受控码(端口占用)回传该码,阶段 connect-run;同 run 不重复', async () => {
    const dataDir = tempDir('laixin-diagnosis-')
    seedImported(dataDir)
    const sent: DiagnosisPayload[] = []
    const tunnel = new TunnelService({
      dataDir, sidecarDir: tempDir('laixin-sidecar-empty-'), trust: loadTrustContext({}, {}), now: () => Date.now(),
      picker: async () => undefined, spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
      routesFile: join(dataDir, 'routes.default.json'),
      diagnosis: { enabled: () => true, version: () => '9.9.9-test', send: async (payload) => { sent.push(payload) } }
    })
    seedDaemonState(dataDir, { state: 'error', code: '端口占用', message: '端口占用' })
    tunnel.status()
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ code: '端口占用', stage: 'connect-run' })
    tunnel.status()
    expect(sent).toHaveLength(1) // 同一终态 ⛔ 每次轮询都重发
  })

  it('守护报错但判不出原因:回传 UNKNOWN + 阶段,⛔ 塞进任何已知码', async () => {
    const dataDir = tempDir('laixin-diagnosis-')
    seedImported(dataDir)
    const sent: DiagnosisPayload[] = []
    const tunnel = new TunnelService({
      dataDir, sidecarDir: tempDir('laixin-sidecar-empty-'), trust: loadTrustContext({}, {}), now: () => Date.now(),
      picker: async () => undefined, spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
      routesFile: join(dataDir, 'routes.default.json'),
      diagnosis: { enabled: () => true, version: () => '9.9.9-test', send: async (payload) => { sent.push(payload) } }
    })
    // 无 code 的守护终态(真实形态:异常退出/放弃后现场丢失)。判不出就如实说不知道。
    seedDaemonState(dataDir, { state: 'error', message: '' })
    tunnel.status()
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].code).toBe('UNKNOWN')
    expect(sent[0].stage).toBe('connect-run')
  })

  it('互斥忙(TUNNEL_BUSY)不算失败终态,⛔ 回传刷屏;修复自己仍如实报', async () => {
    const f = service()
    const started = f.tunnel.repair() // 同步置位修复在途
    expect(started.outcome).toBe('started')
    const busy = await f.tunnel.start()
    expect(busy.code).toBe('TUNNEL_BUSY')
    await vi.waitFor(() => expect(f.tunnel.repairStatus().running).toBe(false))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.sent.some((payload) => payload.code === 'TUNNEL_BUSY')).toBe(false)
  })
})

describe('失败终态回传 · 客户断开自救不算失败(FB-3 件二)', () => {
  it('连接中途点断开:一条都不回传;之后真实失败照常回传(两头都断)', async () => {
    const f = service({ imported: true })
    let claimCalls = 0
    let hangClaim = true
    // claim 脚本:第 1 趟(登录同步)按「后台一时回不对」处理;第 2 趟(连接自带同步)挂起,
    // 直到客户断开中止它;之后真实权益拒绝。⛔ 不靠错误码判「客户断开」,断开走 stop() 意图入口。
    const access = {
      client: {
        claim: async (_session: unknown, signal: AbortSignal) => {
          claimCalls += 1
          if (claimCalls === 1) throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
          if (!hangClaim) throw new NetworkAccountError('NETWORK_AUTHORIZATION_UNAVAILABLE')
          return new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new NetworkAccountError('NETWORK_SESSION_CHANGED'))
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort)
          })
        }
      },
      session: { accountId: 'customer-a', accessToken: 'token', deviceId: 'device-fixture' }
    }
    await f.tunnel.setAccountAccess(access as never)

    const startPromise = f.tunnel.start()
    await vi.waitFor(() => expect(claimCalls).toBe(2)) // 连接自带的同步已挂在网络往返上
    const stopped = await f.tunnel.stop()              // 客户在连接过程中点断开自救
    expect(stopped.outcome).toBe('stopped')
    const started = await startPromise
    expect(started.code).toBe('NETWORK_SESSION_CHANGED')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.sent).toHaveLength(0) // 自救 ⛔ 记成「连接失败」回传

    hangClaim = false
    const retried = await f.tunnel.start() // 正向:真失败(权益拒绝)照常回传
    expect(retried.code).toBe('NETWORK_AUTHORIZATION_UNAVAILABLE')
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    expect(f.sent[0]).toMatchObject({ code: 'NETWORK_AUTHORIZATION_UNAVAILABLE', stage: 'connect-start' })
  })
})

describe('失败终态回传 · 修复流程与开关', () => {
  it('修复结论「仍然失败」回传底层码,阶段 repair', async () => {
    const f = service()
    const outcome = await f.tunnel.repair()
    expect(outcome.outcome).toBe('started')
    await vi.waitFor(() => expect(f.tunnel.repairStatus().running).toBe(false), { timeout: 10_000 })
    const status = f.tunnel.repairStatus()
    expect(status.outcome).toBe('still_failing')
    expect(status.code).toBe('TUNNEL_COMPONENT_MISSING')
    expect(f.sent.some((payload) => payload.code === 'TUNNEL_COMPONENT_MISSING' && payload.stage === 'repair')).toBe(true)
  })

  it('开关关掉:失败一条都不传,失败也不入队(正向与反向都断)', async () => {
    const f = service()
    f.setEnabled(false)
    await f.tunnel.start() // 组件缺失,必失败
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.sent).toHaveLength(0)
    expect(existsSync(f.queuePath)).toBe(false)
  })
})

describe('本地队列 · 后台不可达攒住,恢复后补传', () => {
  function reporter(input: { now?: () => number; queuePath?: string; failCount?: number } = {}) {
    const queuePath = input.queuePath ?? join(tempDir('laixin-diagnosis-queue-'), 'diagnosis-pending.json')
    const sent: DiagnosisPayload[] = []
    // 前 failCount 次发送失败(Infinity = 通道一直断着);之后恢复,入队的靠 flush 补传。
    const failures: Error[] = Array.from({ length: input.failCount ?? 0 }, () => new Error('ECONNREFUSED'))
    const reporter = new DiagnosisReporter({
      send: async (payload) => {
        const failure = failures.shift()
        if (failure) throw failure
        sent.push(payload)
      },
      enabled: () => true,
      platform: 'macos',
      version: () => '9.9.9-test',
      now: input.now ?? (() => 1_000_000),
      queuePath,
      queueCodec: identityQueueCodec
    })
    return { reporter, sent, queuePath, failures }
  }

  it('发送失败入队;flush 按序补传并清空;队列里只有白名单六字段', async () => {
    const f = reporter({ failCount: 1 })
    f.reporter.report({ code: 'TUNNEL_COMPONENT_MISSING', stage: 'connect-start', authorizationId: '' })
    await vi.waitFor(() => expect(existsSync(f.queuePath)).toBe(true))
    expect(f.sent).toHaveLength(0)
    const queued = JSON.parse(readFileSync(f.queuePath, 'utf8')) as DiagnosisPayload[]
    expect(queued).toHaveLength(1)
    expect(Object.keys(queued[0]).sort()).toEqual(['authorizationId', 'clientVersion', 'code', 'platform', 'stage', 'timestamp'])
    await f.reporter.flushPending()
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].code).toBe('TUNNEL_COMPONENT_MISSING')
    expect(JSON.parse(readFileSync(f.queuePath, 'utf8'))).toEqual([])
  })

  it('队列上限 50 条:丢最旧,⛔ 无限攒', async () => {
    const f = reporter({ failCount: DIAGNOSIS_QUEUE_LIMIT + 10 }) // 次次失败,足够盖满用例
    for (let index = 0; index < DIAGNOSIS_QUEUE_LIMIT + 1; index += 1) {
      f.reporter.report({ code: `CODE_${index}`, stage: 'connect-run', authorizationId: '' })
      await vi.waitFor(() => expect((JSON.parse(readFileSync(f.queuePath, 'utf8')) as DiagnosisPayload[]).length).toBe(Math.min(index + 1, DIAGNOSIS_QUEUE_LIMIT)))
    }
    // 第 51 条落盘后长度仍是 50(裁最旧),长度闸分不出「还没到」——等尾条出现再断言。
    await vi.waitFor(() => {
      const queue = JSON.parse(readFileSync(f.queuePath, 'utf8')) as DiagnosisPayload[]
      expect(queue[queue.length - 1]?.code).toBe(`CODE_${DIAGNOSIS_QUEUE_LIMIT}`)
    })
    const queued = JSON.parse(readFileSync(f.queuePath, 'utf8')) as DiagnosisPayload[]
    expect(queued).toHaveLength(DIAGNOSIS_QUEUE_LIMIT)
    expect(queued[0].code).toBe('CODE_1') // 51 进 50 出,丢的是最旧的 CODE_0
  })

  it('超过 7 天的攒批在补传时丢弃,没过期的按序补上', async () => {
    let clock = 0
    const f = reporter({ now: () => clock, failCount: 3 })
    f.reporter.report({ code: 'CODE_OLD', stage: 'connect-run', authorizationId: '' }) // t=0
    await vi.waitFor(() => expect((JSON.parse(readFileSync(f.queuePath, 'utf8')) as DiagnosisPayload[]).length).toBe(1))
    clock += 2 * 24 * 3600_000
    f.reporter.report({ code: 'CODE_NEW', stage: 'connect-run', authorizationId: '' }) // t=2 天
    await vi.waitFor(() => expect((JSON.parse(readFileSync(f.queuePath, 'utf8')) as DiagnosisPayload[]).length).toBe(2))
    clock += 4 * 24 * 3600_000
    f.reporter.report({ code: 'CODE_MID', stage: 'connect-run', authorizationId: '' }) // t=6 天
    await vi.waitFor(() => expect((JSON.parse(readFileSync(f.queuePath, 'utf8')) as DiagnosisPayload[]).length).toBe(3))
    clock += 2 * 24 * 3600_000 // t=8 天:CODE_OLD 满 8 天超龄,CODE_NEW(6 天)/CODE_MID(2 天)还在窗口内
    f.failures.length = 0 // 通道恢复
    await f.reporter.flushPending()
    expect(f.sent.map((payload) => payload.code)).toEqual(['CODE_NEW', 'CODE_MID'])
    expect(JSON.parse(readFileSync(f.queuePath, 'utf8'))).toEqual([])
  })

  it('永久失败(端点不存在/会话过期)不入队空转', async () => {
    const f = reporter({ failCount: 1 })
    ;(f.failures as Error[]).unshift(Object.assign(new NetworkAccountError('NETWORK_ROUTE_NOT_FOUND'), { diagnosisPermanent: 'route' }))
    f.reporter.report({ code: 'CODE_X', stage: 'connect-run', authorizationId: '' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.sent).toHaveLength(0)
    expect(existsSync(f.queuePath)).toBe(false)
  })
})

describe('本地队列 · 补传在途与入队并发(候选甲-11)', () => {
  // 复现「旧快照整体覆盖」:flush 持本地快照在 await send 挂起期间,新失败经 report→enqueue
  // 落盘;flush 恢复后若用旧快照写回,中途入队的条目从未发送就从盘上消失——无日志无报错,
  // 丢的偏是补传窗口内时效性最强的失败样本。
  function concurrentReporter(send: (payload: DiagnosisPayload) => Promise<void>) {
    const queuePath = join(tempDir('laixin-diagnosis-queue-'), 'diagnosis-pending.json')
    const sent: DiagnosisPayload[] = []
    const reporter = new DiagnosisReporter({
      send: async (payload) => { await send(payload); sent.push(payload) },
      enabled: () => true,
      platform: 'macos',
      version: () => '9.9.9-test',
      now: () => 1_000_000,
      queuePath,
      queueCodec: identityQueueCodec
    })
    return { reporter, sent, queuePath }
  }

  function seedQueue(queuePath: string, codes: string[]): void {
    writeFileSync(queuePath, JSON.stringify(codes.map((code) => ({
      code, stage: 'connect-run', platform: 'macos', clientVersion: '9.9.9-test', authorizationId: '', timestamp: 999_000
    }))))
  }

  function readQueueCodes(queuePath: string): string[] {
    return (JSON.parse(readFileSync(queuePath, 'utf8')) as DiagnosisPayload[]).map((entry) => entry.code)
  }

  it('补传在途(send 挂起)时新失败入队:A 照常发出,B 留在盘上,下趟按序补传', async () => {
    let releaseA: (() => void) | undefined
    const attempts = new Map<string, number>()
    const f = concurrentReporter(async (payload) => {
      const attempt = (attempts.get(payload.code) ?? 0) + 1
      attempts.set(payload.code, attempt)
      if (payload.code === 'CODE_A' && attempt === 1) {
        await new Promise<void>((resolve) => { releaseA = resolve }) // 可控慢 send:补传挂在这条上
      }
      if (payload.code === 'CODE_B' && attempt === 1) throw new Error('ECONNREFUSED') // B 直传失败转入队
    })
    seedQueue(f.queuePath, ['CODE_A'])
    const flushing = f.reporter.flushPending()
    await vi.waitFor(() => expect(releaseA).toBeDefined()) // flush 已持快照 [A] 挂在网络往返上
    f.reporter.report({ code: 'CODE_B', stage: 'connect-run', authorizationId: '' })
    await new Promise((resolve) => setTimeout(resolve, 20)) // 让 B 的失败处理与入队落定
    releaseA?.()
    await flushing
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(readQueueCodes(f.queuePath)).toEqual(['CODE_B']) // A 已发出;B ⛔ 被旧快照整体覆盖
    expect(f.sent.map((payload) => payload.code)).toEqual(['CODE_A'])
    expect(attempts.get('CODE_A')).toBe(1) // A 只发一次,⛔ 重发

    await f.reporter.flushPending() // 下一趟补传:B 按序发出,队列清空
    expect(f.sent.map((payload) => payload.code)).toEqual(['CODE_A', 'CODE_B'])
    expect(readQueueCodes(f.queuePath)).toEqual([])
  })

  it('补传失败整批保留时,中途入队的条目一起留下,下趟按序补传', async () => {
    let rejectA: (() => void) | undefined
    const attempts = new Map<string, number>()
    const f = concurrentReporter(async (payload) => {
      const attempt = (attempts.get(payload.code) ?? 0) + 1
      attempts.set(payload.code, attempt)
      if (attempt > 1) return // 通道恢复后的补传正常发出
      if (payload.code === 'CODE_A') {
        await new Promise<void>((_resolve, reject) => { rejectA = () => reject(new Error('ECONNREFUSED')) })
      }
      throw new Error('ECONNREFUSED') // 各码首趟都失败:B 直传失败入队;A 补传失败整批保留
    })
    seedQueue(f.queuePath, ['CODE_A'])
    const flushing = f.reporter.flushPending()
    await vi.waitFor(() => expect(rejectA).toBeDefined())
    f.reporter.report({ code: 'CODE_B', stage: 'connect-run', authorizationId: '' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    rejectA?.()
    await flushing
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(readQueueCodes(f.queuePath)).toEqual(['CODE_A', 'CODE_B']) // 整批保留 ⛔ 把 B 覆盖掉

    await f.reporter.flushPending()
    expect(f.sent.map((payload) => payload.code)).toEqual(['CODE_A', 'CODE_B'])
    expect(readQueueCodes(f.queuePath)).toEqual([])
  })
})
