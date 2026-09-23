// 第 4 条故障注入:桥层把 handler 抛的任何异常统一兜成 ACTION_FAILED,渲染层一律显示
// 「操作未完成,请重试或重新导入来信配置包。」——配置完好的客户被指使重新导入,
// 点断开写意图失败时通道其实还在连。这是 tunnel-service.ts:465 注释明令禁止、但只修了一半的行为。
// 另:status schema 里 currentConfig/pendingConfig 是唯二不限长字段,超长内容没有源头截断护栏。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerActions } from '../../app/main/actions/tunnel'
import type { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { NetworkAccountError } from '../../app/main/tunnel/account-client'
import { PackageReject, REJECT_REASONS } from '../../app/main/tunnel/package-format'
import { computeStatus } from '../../app/main/tunnel/status-service'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

const directory = () => { const root = makeTempDir('ipc-translate-'); roots.push(root); return root }

/** 只长着被点名方法的桩服务;其余成员测试不碰。 */
function stubService(overloads: Partial<Record<'start' | 'stop' | 'status', () => unknown>>): TunnelService {
  return overloads as unknown as TunnelService
}

function registryWith(service: TunnelService): BridgeRegistry {
  const registry = new BridgeRegistry()
  registerActions(registry, { service })
  return registry
}

describe('tunnel.start / tunnel.stop:受控失败在桥层就地翻译', () => {
  it('stop 抛本地写失败 → 如实说「断开未完成,通道可能仍在连接」,⛔ 指使重新导入(基线:ACTION_FAILED 兜成误导文案)', async () => {
    const registry = registryWith(stubService({
      stop: async () => {
        // 真实 fs 写错误的形状:错误对象带 .code(N-18 判据查的就是它,⛔ 只把 EACCES 写进文案)
        const failure = new Error("EACCES: permission denied, open '/Users/x/Library/Application Support/laixin/tunnel/intent.json'")
        ;(failure as NodeJS.ErrnoException).code = 'EACCES'
        throw failure
      }
    }))
    const result = await registry.execute('tunnel.stop', undefined) as { outcome: string; code: string; message: string }
    expect(result.outcome).toBe('rejected')
    expect(result.code).toBe('TUNNEL_LOCAL_WRITE_FAILED')
    expect(result.message).toContain('断开未完成')
    expect(result.message).toContain('仍在连接')
    expect(result.message).not.toContain('重新导入')
  })

  it('stop 抛非预期程序错误(TypeError)→ 不冒充写入失败,但同样交代「通道可能仍在连接」(N-18 对齐)', async () => {
    const registry = registryWith(stubService({
      stop: async () => { throw new TypeError('Cannot read properties of undefined') }
    }))
    const result = await registry.execute('tunnel.stop', undefined) as { outcome: string; code: string; message: string }
    expect(result.outcome).toBe('rejected')
    expect(result.code).toBe('TUNNEL_LOCAL_UNEXPECTED')
    expect(result.message).toContain('仍在连接')
    expect(result.message).not.toContain('重新导入')
  })


  it('start 抛受控账号失败(NetworkAccountError)→ 码与文案原样保留,⛔ 降级成兜底话术', async () => {
    const registry = registryWith(stubService({
      start: async () => { throw new NetworkAccountError('NETWORK_LOGIN_REQUIRED') }
    }))
    const result = await registry.execute('tunnel.start', undefined) as { outcome: string; code: string; message: string }
    expect(result.outcome).toBe('rejected')
    expect(result.code).toBe('NETWORK_LOGIN_REQUIRED')
    expect(result.message).toBe('请先登录来信账号')
  })

  it('start 抛 PackageReject → 拒绝码与查表原因原样透传(基线:异常直漏桥层,必红)', async () => {
    const registry = registryWith(stubService({
      start: async () => { throw new PackageReject('PACKAGE_EXPIRED') }
    }))
    const result = await registry.execute('tunnel.start', undefined) as { outcome: string; code: string; message: string }
    expect(result.outcome).toBe('rejected')
    expect(result.code).toBe('PACKAGE_EXPIRED')
    expect(result.message).toBe(REJECT_REASONS.PACKAGE_EXPIRED)
  })

  it('成功路径原样透传,文案一个字不改(防改坏护栏,基线即绿)', async () => {
    const registry = registryWith(stubService({
      start: async () => ({ outcome: 'started', code: '', message: '连接中' })
    }))
    const result = await registry.execute('tunnel.start', undefined) as { outcome: string; message: string }
    expect(result).toEqual({ outcome: 'started', code: '', message: '连接中' })
  })
})

describe('status 字段限长:超长内容源头截断,轮询不塌', () => {
  it('manifest 塞进 250 字符超长 host → computeStatus 的 currentConfig 截到 300 以内(基线:不限长放行)', () => {
    const dataDir = directory()
    const batchId = '20260916080000-deadbeef'
    const batchDir = join(dataDir, 'imports', batchId)
    mkdirSync(batchDir, { recursive: true })
    const longHost = `${'a'.repeat(250)}.invalid`
    writeFileSync(join(batchDir, 'manifest.json'), JSON.stringify({
      protocol: 'vless-reality', configVersion: 1, authorizationId: `lx-${'a'.repeat(32)}`,
      node: { host: longHost, port: 443 }, expiresAt: '2027-01-01T00:00:00.000Z',
      files: { 'credentials/default': {} }
    }))
    writeFileSync(join(batchDir, 'import-meta.json'), JSON.stringify({ accountId: 'customer-a', sourceLine: 'vless://fixture' }))
    writeFileSync(join(dataDir, 'current'), `${batchId}\n`)

    const status = computeStatus({ dataDir, daemonState: undefined, daemonUnexpectedExitAt: undefined,
      componentMissing: [], sshBinary: '' })
    // 截断护栏成立(schema 才敢加上限而不把轮询打成 ACTION_RESULT_INVALID)
    expect(status.currentConfig.length).toBeLessThanOrEqual(300)
    expect(status.currentConfig).toContain(longHost.slice(0, 40)) // 正向证据:截的是这条超长现场,不是空串蒙混
  })
})
