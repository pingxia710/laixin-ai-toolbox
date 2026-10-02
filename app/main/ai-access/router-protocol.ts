import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const routerReadyPath = '/_laixin/router/ready'
export const routerRefreshPath = '/_laixin/router/refresh'
export const routerStopPath = '/_laixin/router/stop'
export const routerSnapshotPath = '/_laixin/router/snapshot'
export const routerIsolationPath = '/_laixin/router/isolation'
export function routerBodyHash(body: string): string { return createHash('sha256').update(body).digest('hex') }
export const routerControlProtocolVersion = 1
export const routerControlTimeoutMs = 800
export const routerStartupTimeoutMs = 6_000
export const routerDrainTimeoutMs = 5_000

export function routerNonce(): string { return randomBytes(16).toString('hex') }
export function routerProof(secret: string, action: string, nonce: string, bootId: string, port: number): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(`${action}:${nonce}:${bootId}:${String(port)}`).digest('hex')
}
export function sameRouterProof(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}
