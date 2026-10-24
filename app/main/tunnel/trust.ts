// 客户版只信任编入软件的发包公钥；测试信任必须由开发入口显式开启。
// 签名证明来源，不能证明付款状态或服务器已开通。
import { createPublicKey, verify as ed25519Verify, type KeyObject } from 'node:crypto'
import { PackageReject } from './package-format'
import bundledRegistry from '../../../resources/tunnel-issuers.json'

export interface IssuerRegistry {
  readonly schemaVersion: number
  readonly keys: readonly { readonly id: string; readonly algorithm: string; readonly publicKeySpkiBase64: string }[]
}

export interface TrustContext {
  readonly whitelistDigests: readonly string[]
  readonly signingPublicKeys: readonly KeyObject[]
  readonly trustedIssuers?: readonly KeyObject[]
}

export type TrustOutcome = { readonly tier: 'unsigned-test' | 'signed-testkey' | 'signed-issuer' }

export const TRUST_LINES = {
  'unsigned-test': '来源:未签名(内部测试包)',
  'signed-testkey': '来源:已签名(测试密钥)',
  'signed-issuer': '来源:已签名（来信发放）'
} as const

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function loadTrustContext(
  env: NodeJS.ProcessEnv,
  options: { registry?: IssuerRegistry; allowTestKeys?: boolean } = {}
): TrustContext {
  const registry = options.registry ?? bundledRegistry
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.keys) ||
      new Set(registry.keys.map((key) => key.id)).size !== registry.keys.length) {
    throw new Error('ISSUER_REGISTRY_INVALID')
  }
  const trustedIssuers = registry.keys.map((entry) => {
    if (!entry.id || entry.algorithm !== 'ed25519') throw new Error('ISSUER_REGISTRY_INVALID')
    const key = createPublicKey({ key: Buffer.from(entry.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('ISSUER_REGISTRY_INVALID')
    return key
  })
  if (!options.allowTestKeys) return { trustedIssuers, whitelistDigests: [], signingPublicKeys: [] }
  const whitelistDigests = (env.TOOLBOX_TEST_PACKAGE_WHITELIST ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  const signingPublicKeys = (env.TOOLBOX_TEST_SIGNING_PUBLIC_KEY ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((base64) =>
      createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(base64, 'base64')]),
        format: 'der',
        type: 'spki'
      })
    )
  return { trustedIssuers, whitelistDigests, signingPublicKeys }
}

export function evaluateTrust(
  input: { readonly signatureBase64: string; readonly payload: Buffer; readonly packageDigest: string },
  context: TrustContext
): TrustOutcome {
  if (input.signatureBase64 === '') {
    if (context.whitelistDigests.includes(input.packageDigest)) {
      return { tier: 'unsigned-test' }
    }
    throw new PackageReject('PACKAGE_UNSIGNED_UNTRUSTED')
  }
  if (context.signingPublicKeys.length === 0 && !context.trustedIssuers?.length) {
    throw new PackageReject('PACKAGE_SIGNATURE_NO_KEY') // ⛔ 降成未签名
  }
  let signature: Buffer
  try {
    signature = Buffer.from(input.signatureBase64, 'base64')
  } catch {
    throw new PackageReject('PACKAGE_SIGNATURE_INVALID')
  }
  if (context.trustedIssuers?.some((key) => ed25519Verify(null, input.payload, key, signature))) {
    return { tier: 'signed-issuer' }
  }
  const verified = context.signingPublicKeys.some((key) =>
    ed25519Verify(null, input.payload, key, signature)
  )
  if (!verified) {
    throw new PackageReject('PACKAGE_SIGNATURE_INVALID')
  }
  return { tier: 'signed-testkey' }
}
