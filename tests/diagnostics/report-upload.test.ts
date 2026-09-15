import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { generateReceipt, loopsBackToTunnel, saveReportLocally, uploadReport, type ReportRoute, type ReportTransport } from '../../app/main/diagnostics/report-upload'
import { REPORT_RECEIPT_PATTERN } from '../../app/report-types'
import { makeTempDir, removeTempDir } from '../tunnel/helpers'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })

/** 假通道：每条路线的行为显式注入。⛔ 让用例依赖本机装没装代理软件——本机真跑着的代理会把结论带偏。 */
function transport(behaviour: Partial<Record<ReportRoute, { proxy?: string; result?: { status: number; body: string } | Error }>>) {
  const calls: ReportRoute[] = []
  const client: ReportTransport = {
    resolveProxy: async (_url, route) => behaviour[route]?.proxy ?? 'DIRECT',
    post: async (_url, route) => {
      calls.push(route)
      const result = behaviour[route]?.result
      if (result === undefined) throw new Error('ECONNREFUSED')
      if (result instanceof Error) throw result
      return result
    }
  }
  return { client, calls }
}

const ok = { status: 200, body: '{"receipt":"LX-AAAA-AAAA"}' }
const nowait = { delay: async () => undefined }

it('客户正断网时照样发得出去：走 direct，不碰系统代理', async () => {
  // 通道死了、系统代理还指着已经不监听的本机中继——这正是客户点上报的那一刻。
  const { client, calls } = transport({ direct: { result: ok }, system: { proxy: 'PROXY 127.0.0.1:18081' } })
  const outcome = await uploadReport({ url: 'https://laixin.example/v1/report/upload', payload: '{}', transport: client, bridgePort: 18_081, ...nowait })
  expect(outcome.ok).toBe(true)
  expect(outcome.route).toBe('direct')
  expect(calls).toEqual(['direct'])
})

it('direct 不通时才试 system；system 会绕回来信通道就跳过——上报通道 ⛔ 依赖来信通道本身', async () => {
  const { client, calls } = transport({ direct: { result: new Error('ECONNREFUSED') }, system: { proxy: 'PROXY 127.0.0.1:18081', result: ok } })
  const outcome = await uploadReport({ url: 'https://laixin.example/v1/report/upload', payload: '{}', transport: client, bridgePort: 18_081, ...nowait })
  expect(outcome.ok).toBe(false)
  expect(calls).toEqual(['direct', 'direct'])
  expect(outcome.attempts.at(-1)).toEqual({ route: 'system', ok: false, detail: 'skipped-loopback' })
})

it('公司网只准走代理：system 指向的不是来信通道时，direct 失败后接着走 system', async () => {
  const { client, calls } = transport({ direct: { result: new Error('ENETUNREACH') }, system: { proxy: 'PROXY proxy.corp.example:8080', result: ok } })
  const outcome = await uploadReport({ url: 'https://laixin.example/v1/report/upload', payload: '{}', transport: client, bridgePort: 18_081, ...nowait })
  expect(outcome.ok).toBe(true)
  expect(outcome.route).toBe('system')
  expect(calls).toEqual(['direct', 'direct', 'system'])
})

it('后台明说这包不收（4xx）就不再换路线重发，把错误码带回给客户', async () => {
  const { client, calls } = transport({ direct: { result: { status: 400, body: '{"code":"REPORT_TOO_LARGE"}' } }, system: { proxy: 'DIRECT', result: ok } })
  const outcome = await uploadReport({ url: 'https://laixin.example/v1/report/upload', payload: '{}', transport: client, ...nowait })
  expect(outcome).toMatchObject({ ok: false, code: 'REPORT_TOO_LARGE' })
  expect(calls).toEqual(['direct'])
})

it('两条路都不通：整包落到本机文件，回执号还是同一个', async () => {
  const root = makeTempDir('report-upload-'); roots.push(root)
  const receipt = generateReceipt()
  const { client } = transport({})
  const outcome = await uploadReport({ url: 'https://laixin.example/v1/report/upload', payload: '{"receipt":"x"}', transport: client, ...nowait })
  expect(outcome.ok).toBe(false)
  const path = await saveReportLocally(join(root, 'reports'), receipt, JSON.stringify({ receipt, body: {} }))
  expect(path.endsWith(`${receipt}.json`)).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8')) as { receipt: string }).toMatchObject({ receipt })
})

it('回执号念得出来、写得下，且不会两次一样', () => {
  const receipts = new Set(Array.from({ length: 500 }, () => generateReceipt()))
  expect(receipts.size).toBeGreaterThan(490)
  for (const receipt of receipts) expect(REPORT_RECEIPT_PATTERN.test(receipt)).toBe(true)
  // 念错的余地小：随机部分里没有 I L O U（固定前缀 LX- 不算）
  expect([...receipts].map((receipt) => receipt.slice(3)).join('')).not.toMatch(/[ILOU]/)
})

it('认不出端口的本机代理一律当成「可能是来信通道」，宁可跳过这条路线', () => {
  expect(loopsBackToTunnel('PROXY 127.0.0.1:18081', 18_081)).toBe(true)
  expect(loopsBackToTunnel('SOCKS5 127.0.0.1:18081', 18_081)).toBe(true)
  expect(loopsBackToTunnel('PROXY 127.0.0.1:7890', 18_081)).toBe(false)
  expect(loopsBackToTunnel('PROXY proxy.corp.example:8080', 18_081)).toBe(false)
  expect(loopsBackToTunnel('DIRECT', 18_081)).toBe(false)
  expect(loopsBackToTunnel('PROXY 127.0.0.1:18081', undefined)).toBe(true)
})

it('后台 5xx 是后台自己的毛病：同一路线再试，仍不行就换下一条', async () => {
  const { client, calls } = transport({ direct: { result: { status: 503, body: '{"code":"REPORT_STORE_UNAVAILABLE"}' } },
    system: { proxy: 'PROXY proxy.corp.example:8080', result: ok } })
  const outcome = await uploadReport({ url: 'https://laixin.example/v1/report/upload', payload: '{}', transport: client, bridgePort: 18_081, ...nowait })
  expect(outcome.ok).toBe(true)
  expect(calls).toEqual(['direct', 'direct', 'system'])
})
