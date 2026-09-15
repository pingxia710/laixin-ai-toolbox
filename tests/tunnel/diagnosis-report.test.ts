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
    files: { 'credentials/default': {} }
  }))
  writeFileSync(join(batchDir, 'import-meta.json'), JSON.stringify({ accountId: 'customer-a', sourceLine: 'vless://fixture' }))
  writeFileSync(join(dataDir, 'current'), `${batchId}\n`)
  return batchId
}

// 守护终态由守护写进 state.json;主进程经 rawStatus 读到(守护怎么写已被 authorization-expiry 等用例守住)。
function seedDaemonState(dataDir: string, state: Record<string, unknown>): void {
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'run-fixture', ...state }))
}

interface ServiceHandle {
  tunnel: TunnelService
  sent: DiagnosisPayload[]
  queuePath: string
  failNextSendWith: (error?: Error) => void
  setEnabled: (enabled: boolean) => void
}

function service(input: { imported?: boolean } = {}): ServiceHandle {
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
    now: () => Date.now(),
    picker: async () => undefined,
    spawnDaemon: () => ({ on: () => undefined }),
    spawnRestore: () => undefined,
    routesFile: join(dataDir, 'routes.default.json'),
    diagnosis: {
      enabled: () => enabled,
      version: () => '9.9.9-test',
      send: async (payload) => {
        if (sendError) { const error = sendError; sendError = undefined; throw error }
        sent.push(payload)
      }
    }
  })
  return {
    tunnel, sent, queuePath,
    failNextSendWith: (error) => { sendError = error ?? new Error('NETWORK_SERVICE_UNAVAILABLE') },
    setEnabled: (value) => { enabled = value }
  }
}

const deniedAccess = {
  client: { claim: async () => { throw new NetworkAccountError('NETWORK_AUTHORIZATION_UNAVAILABLE') } },
  session: { accountId: 'customer-a', accessToken: 'token', deviceId: 'device-fixture' }
}

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
      queuePath
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
