import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { apiNetworkProof, probeApiNetwork } from '../../sidecar/shared/api-network-continuation.mjs'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it.each(['proof', 'protocol', 'oversize', 'wrong-port', 'bad-target', 'empty', 'timeout'])('网络交接拒绝 %s 响应', async fault => {
  const binding = { pid: process.pid, bootId: 'a'.repeat(32), identitySecret: 'b'.repeat(64), port: 0, bridgePort: 18080 }
  const server = createServer((req, res) => {
    if (fault === 'timeout') return
    if (fault === 'oversize') { res.end('x'.repeat(16385)); return }
    const nonce = String(req.headers['x-laixin-nonce'])
    res.end(JSON.stringify({ protocol: fault === 'protocol' ? 2 : 1, pid: process.pid, bootId: binding.bootId,
      proof: fault === 'proof' ? 'c'.repeat(64) : apiNetworkProof(binding, 'network-ack', nonce),
      network: fault === 'empty' ? [] : [{ proxyUrl: `http://127.0.0.1:${fault === 'wrong-port' ? 18081 : 18080}`,
        targets: [fault === 'bad-target' ? 'api.example:65536' : 'api.example:443'] }] }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  binding.port = (server.address() as { port: number }).port
  expect(await probeApiNetwork(binding)).toBeUndefined()
})
