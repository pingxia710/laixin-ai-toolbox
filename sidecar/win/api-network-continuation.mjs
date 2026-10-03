import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { request } from 'node:http'

export const API_NETWORK_PATH = '/_laixin/router/network'
export function apiNetworkProof(binding, action, nonce) {
  return createHmac('sha256', Buffer.from(binding.identitySecret, 'hex'))
    .update(`${action}:${nonce}:${binding.bootId}:${String(binding.port)}`).digest('hex')
}

/** Only the authenticated router can keep an already-owned bridge available after GUI exit. */
export async function probeApiNetwork(binding) {
  if (!binding || !Number.isSafeInteger(binding.pid) || binding.pid <= 0 ||
      ![binding.port, binding.bridgePort].every(port => Number.isInteger(port) && port > 0 && port <= 65535) ||
      !/^[a-f0-9]{32}$/.test(binding.bootId) || !/^[a-f0-9]{64}$/.test(binding.identitySecret)) return undefined
  const nonce = randomBytes(16).toString('hex')
  return new Promise(resolve => {
    const req = request({ hostname: '127.0.0.1', port: binding.port, path: API_NETWORK_PATH, method: 'POST',
      headers: { 'x-laixin-nonce': nonce, 'x-laixin-proof': apiNetworkProof(binding, 'network', nonce) } }, res => {
      let size = 0
      const chunks = []
      res.on('error', () => resolve(undefined))
      res.on('data', chunk => { size += chunk.length; if (size > 16384) req.destroy(); else chunks.push(chunk) })
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const proof = apiNetworkProof(binding, 'network-ack', nonce)
          if (res.statusCode !== 200 || value.protocol !== 1 || value.pid !== binding.pid || value.bootId !== binding.bootId ||
              typeof value.proof !== 'string' || !/^[a-f0-9]{64}$/.test(value.proof) ||
              !timingSafeEqual(Buffer.from(value.proof, 'hex'), Buffer.from(proof, 'hex')) ||
              !Array.isArray(value.network) || value.network.length > 3) { resolve(undefined); return }
          const targets = new Set()
          for (const entry of value.network) {
            if (entry?.proxyUrl !== `http://127.0.0.1:${binding.bridgePort}`) continue
            if (!Array.isArray(entry.targets) || entry.targets.length > 10) { resolve(undefined); return }
            for (const target of entry.targets) {
              if (typeof target !== 'string' || !/^[a-z0-9.-]+:[1-9][0-9]{0,4}$/.test(target) || Number(target.split(':')[1]) > 65535) {
                resolve(undefined); return
              }
              targets.add(target)
            }
          }
          resolve(targets.size ? { targets: [...targets] } : undefined)
        } catch { resolve(undefined) }
      })
    })
    const timeout = setTimeout(() => req.destroy(), 800)
    req.on('error', () => resolve(undefined))
    req.on('close', () => { clearTimeout(timeout); resolve(undefined) })
    req.end()
  })
}
