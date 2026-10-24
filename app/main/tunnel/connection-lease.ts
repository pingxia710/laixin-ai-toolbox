import { verify, type KeyObject } from 'node:crypto'

export const CONNECTION_LEASE_MS = 180_000
export interface ConnectionLeaseIdentity {
  authorizationId: string
  nodeId: string
  configVersion: number
  configDigest: string
  expiresAt: number
  migrating?: boolean
}
export interface ConnectionLease extends ConnectionLeaseIdentity {
  purpose: 'laixin-existing-connection'
  version: 1
  accountId: string
  issuedAt: number
  notAfter: number
}

/** A lease only permits a bounded continuation of an already authenticated connection. */
export function verifyConnectionLease(token: string, expected: {
  accountId: string; authorizationId: string; configVersion: number; configDigest: string; expiresAt: number
}, keys: readonly KeyObject[], now: number): ConnectionLease {
  const fail = (): never => { throw new Error('NETWORK_LEASE_INVALID') }
  if (typeof token !== 'string' || token.length > 4096) return fail()
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token)
  if (!match) return fail()
  const payload = Buffer.from(match[1], 'base64url')
  const signature = Buffer.from(match[2], 'base64url')
  if (payload.toString('base64url') !== match[1] || signature.toString('base64url') !== match[2] ||
      signature.length !== 64 || !keys.some((key) => key.asymmetricKeyType === 'ed25519' && verify(null, payload, key, signature))) return fail()
  let lease: ConnectionLease
  try { lease = JSON.parse(payload.toString('utf8')) as ConnectionLease } catch { return fail() }
  if (!lease || lease.purpose !== 'laixin-existing-connection' || lease.version !== 1 || lease.migrating ||
      lease.accountId !== expected.accountId || lease.authorizationId !== expected.authorizationId ||
      lease.configVersion !== expected.configVersion || lease.configDigest !== expected.configDigest ||
      lease.expiresAt !== expected.expiresAt || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(lease.nodeId) ||
      !/^[a-f0-9]{64}$/.test(lease.configDigest) || !Number.isSafeInteger(lease.configVersion) || lease.configVersion < 1 ||
      ![lease.issuedAt, lease.notAfter, lease.expiresAt, now].every(Number.isSafeInteger) ||
      lease.issuedAt > now + 30_000 || lease.notAfter <= now || lease.notAfter <= lease.issuedAt ||
      lease.notAfter - lease.issuedAt > CONNECTION_LEASE_MS || lease.notAfter > lease.expiresAt) return fail()
  return lease
}
