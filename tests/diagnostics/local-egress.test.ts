import { expect, it, vi } from 'vitest'
import { collectLocalEgressEvidence } from '../../app/main/network-diagnostics/local-egress'
import { localEgressAssessment, localEgressDescription, normalizeLocalEgressEvidence } from '../../app/shared/local-egress-evidence'

const sampledAt = 1_800_000_000_000

it('完整读到无可用接口、无 IPv4/IPv6 默认路由才指出本机缺出站路径', async () => {
  const evidence = await collectLocalEgressEvidence({ platform: 'win32', now: () => sampledAt,
    run: async () => ({ stdout: '000\r\n', stderr: '' }) })
  expect(evidence).toEqual({ platform: 'windows', sampledAt, interface: 'none', ipv4DefaultRoute: 'absent', ipv6DefaultRoute: 'absent' })
  expect(localEgressAssessment(evidence, 'unknown')).toBe('no-local-egress')
  expect(localEgressDescription(evidence, 'unknown').title).toBe('本机未发现可用出站路径')
  expect(localEgressAssessment(evidence, 'passed')).toBe('unknown')
  expect(localEgressAssessment(evidence, 'attention')).toBe('unknown')
})

it('默认路由存在但固定地址不通，只给出本机配置线索，不推断整机断网', async () => {
  const evidence = await collectLocalEgressEvidence({ platform: 'win32', now: () => sampledAt,
    run: async () => ({ stdout: '110\n', stderr: '' }) })
  expect(evidence).toMatchObject({ interface: 'up', ipv4DefaultRoute: 'present', ipv6DefaultRoute: 'absent' })
  expect(localEgressAssessment(evidence, 'unknown')).toBe('path-indicated')
  expect(localEgressDescription(evidence, 'unknown').detail).toContain('不能证明 DNS、通道或目标服务可用')
  expect(localEgressAssessment({ ...evidence, interface: 'none' }, 'unknown')).toBe('unknown')
})

it('命令失败、超时、部分/多余原文一律未知，原始 SSID、MAC、IP、异常不越过采集出口', async () => {
  const sensitive = 'Wi-Fi / Office-SSID / 00-11-22-33-44-55 / 192.168.1.2'
  for (const run of [
    async () => { throw new Error(sensitive) },
    async () => ({ stdout: `00${sensitive}`, stderr: '' }),
    async () => ({ stdout: '000', stderr: sensitive }),
    async () => ({ stdout: '00', stderr: '' })
  ]) {
    const evidence = await collectLocalEgressEvidence({ platform: 'win32', now: () => sampledAt, run })
    expect(evidence).toEqual({ platform: 'windows', sampledAt, interface: 'unknown', ipv4DefaultRoute: 'unknown', ipv6DefaultRoute: 'unknown' })
    expect(JSON.stringify(evidence)).not.toContain(sensitive)
    expect(localEgressAssessment(evidence, 'unknown')).toBe('unknown')
  }
})

it('非 Windows 不执行命令；非法字段在报告出口再次归一化', async () => {
  const run = vi.fn(async () => ({ stdout: '000', stderr: '' }))
  expect(await collectLocalEgressEvidence({ platform: 'darwin', now: () => sampledAt, run })).toMatchObject({ platform: 'other', interface: 'unknown' })
  expect(run).not.toHaveBeenCalled()
  expect(normalizeLocalEgressEvidence({ platform: 'other', sampledAt, interface: 'none',
    ipv4DefaultRoute: 'absent', ipv6DefaultRoute: 'absent' })).toMatchObject({ interface: 'unknown' })
  expect(normalizeLocalEgressEvidence({ platform: 'windows', sampledAt, interface: 'Wi-Fi',
    ipv4DefaultRoute: 'absent', ipv6DefaultRoute: 'absent', ssid: 'Office-SSID' })).toEqual({
    platform: 'windows', sampledAt, interface: 'unknown', ipv4DefaultRoute: 'unknown', ipv6DefaultRoute: 'unknown'
  })
})
