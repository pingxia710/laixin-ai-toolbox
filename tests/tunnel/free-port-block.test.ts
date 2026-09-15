// A8:需要「一段连续空端口」的测试此前是拿 freePort() 的返回值当段首。
// 那只验了段首一个,而且段落在临时端口区(本机 net.inet.ip.portrange.first = 49152)里,
// 段内其余端口随时被本机别的连接占掉——全量串行跑时就是偶发红的来源。
import { createServer, type Server } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { freePort, freePortBlock } from './fixtures/reality-node'

const opened: Server[] = []
afterEach(async () => { await Promise.all(opened.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) })

const bind = (port: number) => new Promise<Server>((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => resolve(server))
})

it('给出的一整段真的都空着:33 个逐个都能绑上', async () => {
  const first = await freePortBlock(33)
  for (let offset = 0; offset < 33; offset += 1) opened.push(await bind(first + offset))
  expect(opened).toHaveLength(33)
})

it('段首在临时端口区之下,⛔ 跟本机随手分出去的端口抢', async () => {
  const first = await freePortBlock(21)
  expect(first + 20).toBeLessThan(49_152)
  // 对照:freePort() 拿到的就在临时端口区里,所以它的返回值不能当段首用。
  expect(await freePort()).toBeGreaterThanOrEqual(49_152)
})

it('同一进程里两段不重叠:两个 fixture 同时开也不会互相占', async () => {
  const a = await freePortBlock(22), b = await freePortBlock(22)
  expect(Math.abs(a - b)).toBeGreaterThanOrEqual(22)
  for (const first of [a, b]) for (let offset = 0; offset < 22; offset += 1) opened.push(await bind(first + offset))
})
