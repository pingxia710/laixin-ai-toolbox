import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ToolboxUpdater } from '../../app/main/desktop/updater'

it.each(['not-found', 'oversize', 'download'] as const)('更新 %s 分支释放未读取的错误响应', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'laixin-update-cleanup-'))
  const keys = generateKeyPairSync('ed25519')
  const origin = 'https://updates.example/AI-tools/'
  const payload = Buffer.from(JSON.stringify({ version: '0.7.13', notes: 'fixture', assets: {
    'darwin-arm64': { url: `${origin}updates/toolbox.zip`, size: 10, sha256: 'a'.repeat(64), asarSha256: 'b'.repeat(64) }
  } }))
  const manifest = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })
  let closed = 0, errors = 0
  const server = createServer((request, response) => {
    if (scenario === 'download' && request.url?.endsWith('/latest.json')) { response.end(manifest); return }
    errors += 1
    response.on('close', () => { closed += 1 })
    response.writeHead(scenario === 'oversize' ? 200 : scenario === 'not-found' ? 404 : 503,
      scenario === 'oversize' ? { 'Content-Length': 65537 } : {})
    response.write('unfinished body')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`
  const updater = new ToolboxUpdater({ version: '0.7.12', platform: 'darwin-arm64', origin,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), directory: root,
    executable: '/fixture/toolbox', helperPath: '/fixture/helper', packaged: true, quit: () => undefined,
    githubRepository: 'fixture/toolbox', fetch: (input, init) => fetch(`${base}${new URL(String(input)).pathname}`, init) })
  try {
    const checked = await updater.check()
    if (scenario === 'download') {
      expect(checked.state).toBe('available')
      expect((await updater.download()).state).toBe('error')
    } else expect(checked.state).toBe('error')
    expect(errors).toBe(scenario === 'download' ? 1 : 2)
    await vi.waitFor(() => expect(closed).toBe(errors), { timeout: 500, interval: 10 })
  } finally {
    updater.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
