// 「这台电脑不经代理本来就能出外网吗」的探测原语。
// 已接进连接流程(daemon-core 的复用直连判据,探测点 = AI_SERVICE_PROBE_URLS);甲-4 起判据升级为
// 「真发一次 HTTP 请求并校验响应」(见 probe-http-upgrade.test.ts),本文件钉住连接层的行为边界。
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { probeDirectReachability } from '../../sidecar/win/vless-connector.mjs'

const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)) })
})

describe('直连可达探测（复用直连判据，甲-4 起含真请求校验）', () => {
  it('探测点一个都没有：明确抛错，⛔ 默认「能通」', async () => {
    await expect(probeDirectReachability([], 500)).rejects.toThrow()
  })

  it('探测点连不上：抛错，⛔ 把「探不通」吞掉当成通', async () => {
    const dead = await freePort()
    await expect(probeDirectReachability([`http://127.0.0.1:${dead}/`], 800)).rejects.toThrow()
  })

  it('两个探测点里有一个不通就算不通（一个通可能只是运气）', async () => {
    const alive = createHttpServer((req, res) => { res.writeHead(200); res.end('ok') })
    const port = await freePort()
    await new Promise<void>((resolve) => alive.listen(port, '127.0.0.1', () => resolve()))
    const dead = await freePort()
    try {
      await expect(probeDirectReachability([`http://127.0.0.1:${port}/`, `http://127.0.0.1:${dead}/`], 800)).rejects.toThrow()
    } finally { await new Promise<void>((resolve) => alive.close(() => resolve())) }
  })

  it('明文探测点全部真应答：算通（甲-4 起：连上不算数,要拿到 HTTP 响应）', async () => {
    const first = createHttpServer((req, res) => { res.writeHead(200); res.end('ok') })
    const second = createHttpServer((req, res) => { res.writeHead(200); res.end('ok') })
    const portA = await freePort()
    await new Promise<void>((resolve) => first.listen(portA, '127.0.0.1', () => resolve()))
    const portB = await freePort()
    await new Promise<void>((resolve) => second.listen(portB, '127.0.0.1', () => resolve()))
    try {
      await expect(probeDirectReachability([`http://127.0.0.1:${portA}/`, `http://127.0.0.1:${portB}/`], 800)).resolves.toMatchObject({ direct: true })
    } finally {
      await new Promise<void>((resolve) => first.close(() => resolve()))
      await new Promise<void>((resolve) => second.close(() => resolve()))
    }
  })
})
