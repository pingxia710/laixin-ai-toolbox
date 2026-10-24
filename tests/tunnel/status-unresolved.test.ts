import { afterEach, describe, expect, it } from 'vitest'
import { matchesSchema } from '../../app/main/bridge/schema'
import { statusResultSchema } from '../../app/main/actions/tunnel'
import { computeStatus, summarizeUnresolved } from '../../app/main/tunnel/status-service'
import { appendSettingEntry, generateSessionToken } from '../../sidecar/mac/ledger.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir) })

function dataDirWithUnresolved(count: number): string {
  const dataDir = makeTempDir('laixin-status-unresolved-')
  dirs.push(dataDir)
  for (let index = 0; index < count; index++) {
    appendSettingEntry(dataDir, {
      service: `NetworkService-${String(index).padStart(2, '0')}`, item: 'socks-proxy',
      originalValue: null, writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 },
      sessionToken: generateSessionToken(), time: 1
    })
  }
  return dataDir
}

describe('未恢复项汇总不再撑爆 tunnel.status 的结果限长', () => {
  it('同轮自动恢复只展示白名单证据；过期等待记录不冒充仍在重试', () => {
    const input = { dataDir: dataDirWithUnresolved(1), daemonUnexpectedExitAt: undefined, componentMissing: [], sshBinary: '',
      daemonState: { state: 'error', code: 'TUNNEL_RESTORE_INCOMPLETE', restoration: {
        phase: 'waiting', attempts: 3, startedAt: Date.now() - 3000, updatedAt: Date.now(), nextRetryAt: Date.now() + 5000,
        result: 'unconfirmed', lastFailureCode: 'PORT_QUERY_TIMEOUT', secret: 'DO_NOT_COPY_TOKEN'
      } } }
    const status = computeStatus(input)
    expect(status.recoveryState).toBe('running')
    expect(status).toMatchObject({ recoveryDetail: expect.stringContaining('已重试 2 次') })
    expect(status).toMatchObject({ recoveryDetail: expect.stringContaining('端口查询超时') })
    expect(JSON.stringify(status)).not.toContain('DO_NOT_COPY')
    expect(matchesSchema(status, statusResultSchema)).toBe(true)
    const crashed = computeStatus({ ...input, daemonUnexpectedExitAt: Date.now() })
    expect(crashed.recoveryState).toBe('required')
    expect(crashed.recoveryDetail).not.toContain('正在等待自动重试')
    input.daemonState.restoration.updatedAt -= 120_000
    expect(computeStatus(input).recoveryState).toBe('required')
    input.daemonState.restoration.lastFailureCode = 'DO_NOT_COPY_TOKEN'
    expect(JSON.stringify(computeStatus(input))).not.toContain('DO_NOT_COPY')
  })
  it('恢复进程启动前崩溃且账本为空，仍明确要求重试恢复', () => {
    const status = computeStatus({ dataDir: dataDirWithUnresolved(0),
      daemonState: { state: 'error', code: 'TUNNEL_RESTORE_PROCESS_FAILED', message: '恢复程序意外退出' },
      daemonUnexpectedExitAt: undefined, componentMissing: [], sshBinary: '' })
    expect(status).toMatchObject({ state: '异常', recoveryState: 'required', unrestored: '', message: '恢复程序意外退出' })
    expect(matchesSchema(status, statusResultSchema)).toBe(true)
  })

  it('20 个未恢复服务：动作结果通过 schema 校验并标注「等 20 项」', () => {
    const status = computeStatus({ dataDir: dataDirWithUnresolved(20), daemonState: undefined, daemonUnexpectedExitAt: undefined, componentMissing: [], sshBinary: '' })
    expect(status.unrestored).toContain('等20项')
    expect(status.unrestored.length).toBeLessThanOrEqual(300)
    expect(matchesSchema(status, statusResultSchema)).toBe(true)
    expect(status.state).toBe('异常')
  })

  it('少量未恢复项原样完整列出，schema 照常通过', () => {
    const status = computeStatus({ dataDir: dataDirWithUnresolved(2), daemonState: undefined, daemonUnexpectedExitAt: undefined, componentMissing: [], sshBinary: '' })
    expect(status.unrestored).toContain('NetworkService-00/socks-proxy')
    expect(status.unrestored).toContain('NetworkService-01/socks-proxy')
    expect(status.unrestored).not.toContain('等')
    expect(matchesSchema(status, statusResultSchema)).toBe(true)
  })

  it('汇总截断保持在上限内；单项超长也能收敛', () => {
    const many = Array.from({ length: 40 }, (_, index) => `Service-${index}/item:未恢复:待恢复确认`)
    expect(summarizeUnresolved(many)).toMatch(/等40项$/)
    expect(summarizeUnresolved(many).length).toBeLessThanOrEqual(300)
    expect(summarizeUnresolved(many.slice(0, 3)).endsWith(';等3项')).toBe(false)
    const giant = [`Giant/entry:${'x'.repeat(400)}`, 'Short/item:未恢复:已被改动']
    const summarized = summarizeUnresolved(giant)
    expect(summarized.length).toBeLessThanOrEqual(300)
    expect(summarized).toContain('等2项')
  })
})
