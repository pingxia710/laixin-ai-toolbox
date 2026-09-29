import { afterEach, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import type { DiagnosticEvent } from '../../app/diagnostic-event-types'
import type { EncryptedQueueCodec } from '../../app/main/tunnel/diagnostic-event-queue'
import { sidecarComponents } from '../../app/main/tunnel/sidecar-path'
import { loadTrustContext } from '../../app/main/tunnel/trust'
import { makeTempDir, removeTempDir } from './helpers'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(removeTempDir))

function codec(): EncryptedQueueCodec {
  const key = Buffer.alloc(32, 11)
  return {
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plain), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decrypt(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
}

function seedImported(dataDir: string): void {
  const batchId = '20260915010000-cafebabe'
  const batchDir = join(dataDir, 'imports', batchId)
  mkdirSync(batchDir, { recursive: true })
  writeFileSync(join(batchDir, 'manifest.json'), JSON.stringify({
    protocol: 'vless-reality', configVersion: 1, authorizationId: `lx-${'a'.repeat(32)}`,
    node: { host: 'node.test.invalid', port: 443 }, expiresAt: '2027-01-01T00:00:00.000Z',
    files: { 'credentials/default': {} }
  }))
  writeFileSync(join(batchDir, 'import-meta.json'), JSON.stringify({ accountId: 'customer-a', sourceLine: 'fixture' }))
  writeFileSync(join(dataDir, 'current'), `${batchId}\n`)
}

function completeSidecar(root: string): string {
  const sidecarDir = join(root, 'sidecar', 'mac')
  mkdirSync(sidecarDir, { recursive: true })
  for (const name of sidecarComponents('macos')) writeFileSync(join(sidecarDir, name), '')
  const xrayDir = join(root, 'xray')
  mkdirSync(xrayDir, { recursive: true })
  for (const name of ['xray', 'geoip.dat', 'geosite.dat']) writeFileSync(join(xrayDir, name), '')
  return sidecarDir
}

it('TunnelService 只在 networkPathReady 有效连接读回后补传闭环事件', async () => {
  const root = makeTempDir('laixin-n53-integration-')
  directories.push(root)
  const dataDir = join(root, 'data')
  seedImported(dataDir)
  const sent: DiagnosticEvent[] = []
  const tunnel = new TunnelService({
    dataDir,
    sidecarDir: completeSidecar(root),
    trust: loadTrustContext({}, {}),
    now: () => 1_000_000,
    picker: async () => undefined,
    spawnDaemon: () => ({ on: () => undefined }),
    spawnRestore: () => undefined,
    routesFile: join(root, 'routes.default.json'),
    resident: { armed: () => true, alive: () => true, wake: async () => true, seatRunId: () => 'run-fixture' },
    diagnosis: {
      enabled: () => true,
      version: () => '0.5.20-test',
      send: async () => undefined,
      eventQueue: {
        queuePath: join(dataDir, 'diagnostic-events.enc'),
        codec: codec(),
        canSend: () => true,
        send: async (event) => { sent.push(event) }
      }
    }
  })

  const internal = tunnel as unknown as { reportFailure: (code: string, stage: 'connect-run') => void }
  internal.reportFailure('TUNNEL_AVAILABILITY_RECLAIM_LIMIT', 'connect-run')
  await new Promise((resolve) => setTimeout(resolve, 20))

  writeFileSync(join(dataDir, 'intent.json'), JSON.stringify({ desired: 'connected', sessionToken: 'current' }))
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({
    state: 'degraded', runId: 'run-fixture', intentToken: 'current', sessionToken: 'current'
  }))
  tunnel.status()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(sent).toEqual([])

  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({
    state: 'connected', runId: 'run-fixture', intentToken: 'current', sessionToken: 'current',
    exitIp: '203.0.113.8', lastVerifiedAt: 1_000_000
  }))
  tunnel.status()
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({
    failureCategory: 'TUNNEL_AVAILABILITY_RECLAIM_LIMIT',
    resultBucket: 'recovered',
    pathType: 'laixin',
    repairAction: 'reconnect',
    repairResult: 'recovered'
  })
})
