// 测试配置包构造器:全假值(假密钥、回环主机、文档保留段指纹)。⛔ 任何真实凭据。
import { generateKeyPairSync, randomBytes, sign as ed25519Sign, type KeyObject } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  canonicalManifestPayload,
  hostKeyFingerprintOf,
  packageDigest,
  sha256Hex,
  type PackageEntry,
  type TunnelPackageManifest
} from '../../../app/main/tunnel/package-format'

export interface BuiltPackage {
  readonly entries: PackageEntry[]
  readonly manifest: TunnelPackageManifest
  readonly digest: string
}

export interface PackageOverrides {
  readonly issuer?: string
  readonly configVersion?: number
  readonly authorizationId?: string
  readonly platform?: string
  readonly host?: string
  readonly port?: number
  readonly sshUser?: string
  readonly fingerprint?: string // 缺省 = 与 hostkey.pub 一致;显式 '' = 缺指纹 fixture
  readonly expiresAt?: string
  readonly issuedAt?: string
  readonly signature?: string
  readonly signWith?: KeyObject // 测试密钥对签名(供给未到位前的「已签名」fixture)
  readonly extraFiles?: Readonly<Record<string, string>> // 附加文件(自动进清单)
  readonly manifestMutate?: (manifest: Record<string, unknown>) => void
  readonly hostKeyHost?: string // hostkey.pub 行里的主机名(缺省 = host)
  readonly omitHostKey?: boolean
  readonly omitCredential?: boolean
}

export function makeHostKeyLine(host: string): { line: string; fingerprint: string } {
  // 合成 ssh-ed25519 公钥线格式: string "ssh-ed25519" ++ string <32字节>
  const keyBytes = randomBytes(32)
  const algo = Buffer.from('ssh-ed25519', 'utf8')
  const blob = Buffer.concat([
    lengthPrefixed(algo),
    lengthPrefixed(keyBytes)
  ])
  const base64 = blob.toString('base64')
  return { line: `${host} ssh-ed25519 ${base64}`, fingerprint: hostKeyFingerprintOf(base64) }
}

function lengthPrefixed(data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, data])
}

export function makeTestKeyPair(): { publicKey: KeyObject; privateKey: KeyObject; publicKeyBase64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { publicKey, privateKey, publicKeyBase64: der.subarray(-32).toString('base64') }
}

export function buildPackageEntries(overrides: PackageOverrides = {}): BuiltPackage {
  const host = overrides.host ?? 'node-a.test.invalid'
  const hostKey = makeHostKeyLine(overrides.hostKeyHost ?? host)
  const manifest: Record<string, unknown> = {
    issuer: overrides.issuer ?? 'laixin-01',
    configVersion: overrides.configVersion ?? 1,
    authorizationId: overrides.authorizationId ?? 'lx-test0001',
    platform: overrides.platform ?? 'mac',
    node: {
      host,
      port: overrides.port ?? 22,
      hostKeyFingerprint: overrides.fingerprint ?? hostKey.fingerprint,
      sshUser: overrides.sshUser ?? 'lxr-test'
    },
    issuedAt: overrides.issuedAt ?? '2026-09-01T00:00:00Z',
    expiresAt: overrides.expiresAt ?? '2027-01-01T00:00:00Z',
    files: {} as Record<string, string>,
    signature: ''
  }

  const files: Record<string, Buffer> = {}
  if (overrides.omitCredential !== true) {
    files['credentials/id_ed25519'] = Buffer.from(
      'FAKE-TEST-PRIVATE-KEY-NOT-REAL-仅供测试的假凭据内容',
      'utf8'
    )
  }
  if (overrides.omitHostKey !== true) {
    files['hostkey.pub'] = Buffer.from(`${hostKey.line}\n`, 'utf8')
  }
  for (const [path, content] of Object.entries(overrides.extraFiles ?? {})) {
    files[path] = Buffer.from(content, 'utf8')
  }
  const filesTable = manifest.files as Record<string, string>
  for (const [path, data] of Object.entries(files)) {
    filesTable[path] = sha256Hex(data)
  }
  // 先填内容清单,再让 fixture 改 manifest(保持「清单不符」等注入有效),最后签名。
  overrides.manifestMutate?.(manifest)

  let signature = overrides.signature ?? ''
  if (overrides.signWith !== undefined) {
    signature = ed25519Sign(
      null,
      canonicalManifestPayload(manifest as unknown as TunnelPackageManifest),
      overrides.signWith
    ).toString('base64')
  }
  manifest.signature = signature

  const entries: PackageEntry[] = [
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ...Object.entries(files).map(([path, data]) => ({ path, data }))
  ]
  return { entries, manifest: manifest as unknown as TunnelPackageManifest, digest: packageDigest(entries) }
}

export function writePackageDir(root: string, built: BuiltPackage): string {
  for (const entry of built.entries) {
    const target = join(root, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
  }
  return root
}
