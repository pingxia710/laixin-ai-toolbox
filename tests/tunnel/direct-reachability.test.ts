// 「这台电脑不经代理本来就能出外网吗」的探测原语。
// **目前没有接进连接流程**——判据还没定：拿通用探测点当判据会把「能开网页」误判成「能用 AI」，
// 公司网络常放行 Google 却拦着 AI 服务。本机实测过这个误判的后果（见 docs 同日记录）。
// 原语先备着并钉住行为，等判据（探客户真正要用的那些服务）定了再接线。
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { probeDirectReachability } from '../../sidecar/win/vless-connector.mjs'

const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)) })
})

describe('直连可达探测（原语，未接线）', () => {
  it('探测点一个都没有：明确抛错，⛔ 默认「能通」', async () => {
    await expect(probeDirectReachability([], 500)).rejects.toThrow()
  })

  it('探测点连不上：抛错，⛔ 把「探不通」吞掉当成通', async () => {
    const dead = await freePort()
    await expect(probeDirectReachability([`http://127.0.0.1:${dead}/`], 800)).rejects.toThrow()
  })

  it('两个探测点里有一个不通就算不通（一个通可能只是运气）', async () => {
    const alive = createServer((socket) => socket.end())
    const port = await freePort()
    await new Promise<void>((resolve) => alive.listen(port, '127.0.0.1', () => resolve()))
    const dead = await freePort()
    try {
      await expect(probeDirectReachability([`http://127.0.0.1:${port}/`, `http://127.0.0.1:${dead}/`], 800)).rejects.toThrow()
    } finally { await new Promise<void>((resolve) => alive.close(() => resolve())) }
  })

  it('明文探测点全部连得上：算通（不做 TLS 握手那一步）', async () => {
    const first = createServer((socket) => socket.end())
    const second = createServer((socket) => socket.end())
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
