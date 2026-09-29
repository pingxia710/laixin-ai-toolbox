import { expect, it } from 'vitest'
import { createDeliveryOptimizationAdmission, createProxyDestinationAdmissionTransform } from '../../sidecar/mac/download-concurrency.mjs'

const host = 'content.dl.delivery.mp.microsoft.com'
const request = (target = host) => Buffer.from(`CONNECT ${target}:443 HTTP/1.1\r\n\r\n`)
const settle = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }

it('已获准但 await 尚未返回时销毁，名额归还且后续下载能进入', async () => {
  const admission = createDeliveryOptimizationAdmission()
  for (let index = 0; index < 4; index++) {
    const { stream } = createProxyDestinationAdmissionTransform(admission)
    stream.write(request())
    stream.destroy()
  }
  await settle()
  expect(admission.status()).toMatchObject({ active: 0, queued: 0 })
  const next = await admission.acquire(host)
  expect(admission.status().active).toBe(1)
  next?.release()
  expect(admission.status().active).toBe(0)
})

it.each(['queued', 'granted'] as const)('排队下载在 %s 阶段取消不占名额，不转发已取消请求', async phase => {
  const admission = createDeliveryOptimizationAdmission()
  const held = await Promise.all(Array.from({ length: 4 }, () => admission.acquire(host)))
  const { stream } = createProxyDestinationAdmissionTransform(admission)
  const forwarded: Buffer[] = []
  stream.on('data', chunk => forwarded.push(chunk))
  stream.write(request())
  expect(admission.status().queued).toBe(1)
  if (phase === 'granted') held[0]?.release()
  stream.destroy()
  await settle()
  expect(forwarded).toEqual([])
  expect(admission.status()).toMatchObject({ active: phase === 'granted' ? 3 : 4, queued: 0 })
  for (const lease of held) lease?.release()
  expect(admission.status().active).toBe(0)
})

it('正常完成与重复销毁只释放一次，普通目标从不占用名额', async () => {
  const admission = createDeliveryOptimizationAdmission()
  const { stream } = createProxyDestinationAdmissionTransform(admission)
  stream.write(request())
  await settle()
  expect(admission.status().active).toBe(1)
  stream.destroy(); stream.destroy()
  expect(admission.status().active).toBe(0)
  const ordinary = createProxyDestinationAdmissionTransform(admission)
  ordinary.stream.write(request('api.example.test'))
  ordinary.stream.destroy()
  await settle()
  expect(admission.status()).toMatchObject({ active: 0, queued: 0 })
})
