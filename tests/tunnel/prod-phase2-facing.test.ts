// Phase 2 错误诚实族:P0-1 TOP 榜两头的码必须变成客户能照做的一句话。
// M2 判据:那句话里有一个客户自己能执行的动作。核对路径同 P0-1 口径:
// 守护 error 态 → connectionMessage 查表 → 渲染层;修复流走 REPAIR_REASONS;账号类走 accountFailure。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeStatus, connectionMessage, type StatusInput } from '../../app/main/tunnel/status-service'
import { accountFailure, REPAIR_REASONS } from '../../app/main/tunnel/tunnel-service'

describe('「上游不可达」不能再以裸码或无动作的计数文案出现在客户眼前', () => {
  it('失败路径(message=code):给出一句话,含客户自己能做的动作', () => {
    const shown = connectionMessage({ state: 'error', code: '上游不可达', message: '上游不可达' } as never)
    expect(shown).not.toBe('上游不可达')
    expect(shown).toMatch(/重连|重试/)
    expect(shown).toMatch(/换|诊断/)
    expect(shown).toMatch(/请/)
  })

  it('重连计数路径(动态文案不在表内):同样要落到可照做的那句', () => {
    const shown = connectionMessage({ state: 'error', code: '上游不可达', message: '连接中断,自动重连中(2/5)' } as never)
    expect(shown).toMatch(/换|诊断/)
    expect(shown).toMatch(/重连|重试/)
    expect(shown).not.toContain('上游不可达')
  })

  it('修复路径:上游不可达进修复原因表,给可照做的一句', () => {
    const text = REPAIR_REASONS['上游不可达']
    expect(text).toBeTruthy()
    expect(text).toMatch(/请/)
    expect(text).toMatch(/网络|诊断/)
  })
})

describe('NETWORK_AUTHORIZATION_UNAVAILABLE 要告诉客户「去哪查」', () => {
  it('账号失败文案指向「我的账号」页', () => {
    const { message } = accountFailure('NETWORK_AUTHORIZATION_UNAVAILABLE')
    expect(message).toContain('我的账号')
    expect(message).toMatch(/套餐|额度/)
  })
})

describe('UNKNOWN 终态不再只给状态词', () => {
  // M2 判据:判不出原因(归 UNKNOWN)≠ 没有客户动作。守护意外退出的终态原来是「守护进程意外退出」——
  // 一个自己能做的事都没有;诚实且可照做的做法是「如实的状态 + 重新连接/复制诊断」。
  it('守护意外退出终态给可照做的一句话,⛔ 只给内部状态词', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'prod-phase2-unknown-'))
    try {
      // 造一份最小已导入批次:意外退出终态只在「已导入配置」的前提下出现(复用 reused-path 测试的夹具形态)。
      const batchId = '20260919000000-a1b2c3d4'
      mkdirSync(join(dataDir, 'imports', batchId, 'credentials'), { recursive: true })
      writeFileSync(join(dataDir, 'imports', batchId, 'manifest.json'), JSON.stringify({
        protocol: 'vless-reality', verifyUrl: 'https://laixin.net.cn/exit-ip', configVersion: 1,
        authorizationId: 'lx-' + 'a'.repeat(32), node: { host: '198.51.100.7', port: 443 },
        expiresAt: '2099-01-01T00:00:00Z', files: { 'credentials/vless.json': 'x' }
      }))
      writeFileSync(join(dataDir, 'imports', batchId, 'credentials', 'vless.json'), '{}')
      writeFileSync(join(dataDir, 'current'), batchId)
      const input: StatusInput = {
        dataDir, daemonState: undefined, daemonUnexpectedExitAt: 1_000, componentMissing: [], sshBinary: ''
      }
      const status = computeStatus(input)
      expect(status.state).toBe('异常')
      expect(status.message).not.toBe('守护进程意外退出')
      expect(status.message).toMatch(/重新连接|重试/)
      expect(status.message).toMatch(/诊断|客服/)
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })
})
