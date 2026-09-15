import { expect, it } from 'vitest'
import { groupQrManifestUrl, resolveGroupQr } from '../../app/renderer/src/referral-config'

const validManifest = {
  kind: 'wecom-group-live-code',
  version: '20260915T020000Z',
  imageUrl: 'https://laixin.net.cn/AI-tools/group-entry/qr/20260915T020000Z.png'
}
const bundledLiveCode = { label: '群', title: '群', description: '群', ready: true, qrImageSrc: 'bundled-live-code.png' }

it('群活码只接受来信官网专用目录和官方群活码标识，拒绝普通群码、第三方和跨目录', async () => {
  expect(groupQrManifestUrl).toBe('https://laixin.net.cn/AI-tools/group-entry/manifest.json')
  const remote = await resolveGroupQr({ fetcher: async () => new Response(JSON.stringify(validManifest), { status: 200 }) })
  expect(remote).toEqual({ source: 'remote', imageUrl: validManifest.imageUrl })

  for (const manifest of [
    { ...validManifest, kind: 'temporary-group-qr' },
    { ...validManifest, imageUrl: 'https://elsewhere.example/qr.png' },
    { ...validManifest, imageUrl: 'https://laixin.net.cn/AI-tools/updates/qr.png' }
  ]) {
    const result = await resolveGroupQr({ fetcher: async () => new Response(JSON.stringify(manifest), { status: 200 }), config: bundledLiveCode })
    expect(result.source).toBe('bundled')
  }
})

it('官网清单读取失败时，已随包的群活码仍可长期作为离线入口；尚未配置时如实显示更新中', async () => {
  const bundled = await resolveGroupQr({ fetcher: async () => new Response('', { status: 503 }), config: bundledLiveCode })
  expect(bundled.source).toBe('bundled')

  const stillBundled = await resolveGroupQr({
    fetcher: async () => new Response('', { status: 503 }), config: bundledLiveCode
  })
  expect(stillBundled.source).toBe('bundled')

  const unavailable = await resolveGroupQr({
    fetcher: async () => new Response('', { status: 503 }),
    config: { label: '群', title: '群', description: '群', ready: false }
  })
  expect(unavailable).toEqual({ source: 'unavailable' })
})
