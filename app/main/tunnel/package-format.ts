// 配置包格式与校验(本片拥有;01 维护方按此出包)。manifest 字段与拒绝原因码逐条对应
// 定稿第 4 轮 2 / 2b③。包内自报的签发方与摘要只作格式核,⛔ 自证来源(信任判定在 trust.ts)。
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { RouteTable } from '../../../sidecar/mac/daemon-core.mjs'
import { parseVlessCredential, validNodeHost, validVerifyUrl, validVerifyFallbackUrl } from '../../../sidecar/mac/vless-settings.mjs'
import { platformForRuntime } from './sidecar-path'
import type { Platform } from '../precheck/software-platform'
import type { TrustContext, TrustOutcome } from './trust'
import { evaluateTrust } from './trust'

export const ISSUER_ID = 'laixin-01'

export const REJECT_REASONS = {
  PACKAGE_MANIFEST_MISSING: '配置包无效:缺 manifest.json',
  PACKAGE_MALFORMED: '配置包无效:包损坏或格式不符',
  PACKAGE_CONTENT_HASH_MISMATCH: '配置包无效:内容摘要不符',
  PACKAGE_ISSUER_MISMATCH: '配置包无效:签发方不符',
  PACKAGE_PLATFORM_MISMATCH: '配置包无效:平台不符',
  PACKAGE_NODE_HOST_MISMATCH: '配置包无效:节点主机与清单不一致',
  PACKAGE_PORT_INVALID: '配置包无效:端口越界',
  PACKAGE_HOST_FINGERPRINT_MISSING: '配置包无效:缺主机密钥指纹',
  PACKAGE_HOST_FINGERPRINT_MISMATCH: '配置包无效:主机密钥指纹与清单不符',
  PACKAGE_SSH_USER_MISSING: '配置包无效:缺受限 SSH 用户名',
  PACKAGE_CREDENTIAL_ESCAPE: '配置包无效:凭据引用越界',
  PACKAGE_EXPIRED: '配置包已过期',
  PACKAGE_AUTH_ID_INVALID: '配置包无效:授权 id 格式不合',
  PACKAGE_VERSION_REGRESSION: '配置包无效:配置版本低于当前',
  PACKAGE_VERSION_CONFLICT: '配置包无效:同版本内容不一致',
  PACKAGE_OVERLAY_NOT_ALLOWED: '配置包无效:分流覆盖越界',
  PACKAGE_ENTRY_UNSAFE: '配置包拒绝:含不安全条目',
  PACKAGE_AUTH_ID_MISMATCH: '配置包无效:所属客户与当前不符',
  PACKAGE_SIGNATURE_NO_KEY: '配置包拒绝:有签名但无验签公钥',
  PACKAGE_SIGNATURE_INVALID: '配置包拒绝:签名校验失败',
  PACKAGE_UNSIGNED_UNTRUSTED: '配置包拒绝:未签名且不在测试白名单',
  PACKAGE_PROTOCOL_INVALID: '配置包无效:本版不支持此连接配置'
} as const

export type RejectCode = keyof typeof REJECT_REASONS

export class PackageReject extends Error {
  constructor(readonly code: RejectCode) {
    super(REJECT_REASONS[code])
    this.name = 'PackageReject'
  }
}

export interface PackageEntry {
  readonly path: string
  readonly data: Buffer
}

export interface TunnelPackageManifest {
  readonly protocol?: 'ssh-socks' | 'vless-reality'
  readonly verifyUrl?: string
  readonly verifyFallbackUrl?: string
  readonly issuer: string
  readonly configVersion: number
  readonly authorizationId: string
  readonly platform: string
  readonly node: {
    readonly host: string
    readonly port: number
    readonly hostKeyFingerprint?: string
    readonly sshUser?: string
  }
  /** 隐藏多节点(创始人 09-13 晚放行):同一份授权里带多个入口/节点,客户端自动挑能用的、坏了自动换,
   * 客户界面上仍只有「连接」。⛔ 节点列表、⛔ 让客户选。
   * 向后兼容:缺省即单节点(等价于 [node]);存在时第一项必须与 `node` 同址——单一事实源,⛔ 两处说法不一。
   * 旧客户端读新包:忽略本字段只用 `node`,签名照样对得上(载荷是整份 manifest 的稳定序列化)。 */
  readonly nodes?: readonly {
    readonly host: string
    readonly port: number
    /** 该入口自己的凭据文件名(credentials/ 下);缺省用 credentials/vless.json。 */
    readonly credentialFile?: string
    /** 该入口自己的回显地址;缺省用 manifest.verifyUrl。 */
    readonly verifyUrl?: string
  }[]
  readonly issuedAt: string
  readonly expiresAt: string
  readonly files: Readonly<Record<string, string>>
  readonly signature: string
}

export interface ValidatedPackage {
  readonly manifest: TunnelPackageManifest
  readonly trust: TrustOutcome
  readonly packageDigest: string
  readonly credentialPaths: readonly string[]
  readonly hostKeyLine: string
  readonly overlay: RouteOverlay | undefined
}

export interface RouteOverlay {
  readonly tunnelDomains: readonly string[]
  readonly directDomains?: readonly string[]
}

/** Compose only validated package rules; both platforms and route explanations use this same table. */
export function composeRoutes(defaults: RouteTable, overlay: RouteOverlay | undefined): RouteTable {
  return {
    directSuffixes: [...new Set([...defaults.directSuffixes, ...(overlay?.directDomains ?? [])])],
    protectedDirectSuffixes: [...defaults.protectedDirectSuffixes],
    tunnelSuffixes: [...new Set([...(defaults.tunnelSuffixes ?? []), ...(overlay?.tunnelDomains ?? [])])],
    // 专用表只来自基础分流表:overlay 键集(tunnelDomains/directDomains)写不进它,
    // 专用规则又排在 overlay 规则之前 —— 签名补充既改不了也盖不掉专用指向(CH-1)。
    ...(defaults.dedicatedSuffixes !== undefined ? { dedicatedSuffixes: [...defaults.dedicatedSuffixes] } : {})
  }
}

const AUTH_ID_PATTERN = /^lx-[a-z0-9]{6,64}$/
const CREDENTIAL_PATH_PATTERN = /^credentials\/[A-Za-z0-9._-]+$/
const ALLOWED_TOP = new Set(['hostkey.pub', 'overlay.json'])
// Even a signed supplement cannot change DeepSeek's protected route.
const PROTECTED_DIRECT_SUFFIXES = ['deepseek.com', 'deepseek.cn', 'deepseek.ai']
// Conservative local guard, not a full public-suffix registry. Broad shared scopes are never routing supplements.
const PUBLIC_CATEGORY_LABELS = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org', 'mil', 'nom', 'ne', 'or', 'go', 'gob', 'id', 'asn', 'firm', 'gen', 'ind', 'sch', 'ltd', 'plc'])
const SHARED_SUFFIXES = new Set(['github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'railway.app', 'onrender.com', 'appspot.com', 'blogspot.com', 'cloudfront.net', 'azurewebsites.net',
  'amazonaws.com', 's3.amazonaws.com', 'aliyuncs.com', 'myqcloud.com', 'cloudfunctions.net', 'web.app', 'firebaseapp.com',
  'ngrok.io', 'ngrok-free.app', 'duckdns.org'])
const overlaps = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)

function validRuleDomain(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 253 || isIP(value) !== 0) return false
  const labels = value.split('.')
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /^[a-z]{2,63}$/.test(labels.at(-1)!) && !(labels.length === 2 && PUBLIC_CATEGORY_LABELS.has(labels[0])) && !SHARED_SUFFIXES.has(value)
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// 整包摘要:排序后的「sha256  相对路径」行再取 sha256(含 manifest.json 本身)。
export function packageDigest(entries: readonly PackageEntry[]): string {
  const lines = entries
    .map((entry) => `${sha256Hex(entry.data)}  ${entry.path}`)
    .sort()
    .join('\n')
  return sha256Hex(Buffer.from(lines, 'utf8'))
}

// 签名载荷:manifest 去掉 signature 字段后的规范 JSON(键排序)。
/** 入口凭据文件名:credentials/vless.json 或 credentials/vless-<字母数字-_>.json。⛔ 目录穿越、⛔ 任意文件名。 */
const VLESS_CREDENTIAL_FILE = /^credentials\/vless(?:-[A-Za-z0-9_-]{1,32})?\.json$/
/** 一份授权里最多几个入口。够用即可——⛔ 让一份配置把探测流量放大到无边。 */
export const MAX_PACKAGE_NODES = 8

/** 多入口清单的校验:每项地址端口合法;第一项必须与 `node` 同址(单一事实源);数量有上限;⛔ 重复入口。 */
function validateNodeList(manifest: TunnelPackageManifest): void {
  const nodes = manifest.nodes
  if (nodes === undefined) return
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_PACKAGE_NODES) {
    throw new PackageReject('PACKAGE_MALFORMED')
  }
  const seen = new Set<string>()
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') throw new PackageReject('PACKAGE_MALFORMED')
    if (!validNodeHost(node.host)) throw new PackageReject('PACKAGE_MALFORMED')
    if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) throw new PackageReject('PACKAGE_PORT_INVALID')
    if (node.credentialFile !== undefined &&
        (typeof node.credentialFile !== 'string' || !VLESS_CREDENTIAL_FILE.test(`credentials/${node.credentialFile}`))) {
      throw new PackageReject('PACKAGE_MALFORMED')
    }
    const key = `${node.host}:${String(node.port)}`
    if (seen.has(key)) throw new PackageReject('PACKAGE_MALFORMED')
    seen.add(key)
  }
  if (nodes[0].host !== manifest.node.host || nodes[0].port !== manifest.node.port) {
    throw new PackageReject('PACKAGE_MALFORMED')
  }
}

export function canonicalManifestPayload(manifest: TunnelPackageManifest): Buffer {
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'signature')
  )
  return Buffer.from(stableStringify(unsigned), 'utf8')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

// OpenSSH 指纹:SHA256:<base64(sha256(密钥线格式)) 去 padding>。
export function hostKeyFingerprintOf(base64Key: string): string {
  const blob = Buffer.from(base64Key, 'base64')
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

export function parseManifest(entries: readonly PackageEntry[]): TunnelPackageManifest {
  const entry = entries.find((candidate) => candidate.path === 'manifest.json')
  if (entry === undefined) {
    throw new PackageReject('PACKAGE_MANIFEST_MISSING')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(entry.data.toString('utf8'))
  } catch {
    throw new PackageReject('PACKAGE_MALFORMED')
  }
  if (!isManifest(parsed)) {
    throw new PackageReject('PACKAGE_MALFORMED')
  }
  return parsed
}

function isManifest(value: unknown): value is TunnelPackageManifest {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  const node = candidate.node as Record<string, unknown> | undefined
  return (
    typeof candidate.issuer === 'string' &&
    typeof candidate.configVersion === 'number' &&
    typeof candidate.authorizationId === 'string' &&
    typeof candidate.platform === 'string' &&
    typeof node === 'object' &&
    node !== null &&
    typeof node.host === 'string' &&
    typeof node.port === 'number' &&
    typeof candidate.issuedAt === 'string' &&
    typeof candidate.expiresAt === 'string' &&
    typeof candidate.files === 'object' &&
    candidate.files !== null &&
    typeof candidate.signature === 'string'
  )
}

export interface ValidateContext {
  readonly now: number
  readonly currentVersion: number | undefined
  readonly currentAuthorizationId: string | undefined
  // 已接受当前包的摘要。仅在同一授权、同一版本时用于拒绝不同内容；缺省保持旧调用方兼容。
  readonly currentPackageDigest?: string
  readonly trust: TrustContext
  // 接收方运行平台;缺省按进程平台推导。manifest 平台与它不符 = 拒(PACKAGE_PLATFORM_MISMATCH)。
  readonly runtimePlatform?: Platform
}

// manifest 平台词汇:macos 端沿用现行签发口径 'mac';windows 端为 'windows'。
// ⛔ 接受对方平台的包(mac 包在 Windows 机上会把 SSH/VLESS 原语接错面)。
export function packagePlatformMatches(manifestPlatform: string, runtimePlatform: Platform): boolean {
  return runtimePlatform === 'macos' ? manifestPlatform === 'mac' : manifestPlatform === 'windows'
}

export function validatePackage(entries: readonly PackageEntry[], context: ValidateContext): ValidatedPackage {
  // 凭据引用越界先核(判据 6):manifest 尚未解析前,先按「清单键的允许形态」预核——
  // 解析后还会再核一次(那时有 files 表)。
  const manifest = parseManifest(entries)
  if (manifest.verifyFallbackUrl !== undefined && (manifest.protocol !== 'vless-reality' ||
      !validVerifyFallbackUrl(manifest.verifyUrl, manifest.verifyFallbackUrl))) {
    throw new PackageReject('PACKAGE_PROTOCOL_INVALID')
  }
  if (!Number.isSafeInteger(manifest.configVersion) || manifest.configVersion < 1) {
    throw new PackageReject('PACKAGE_MALFORMED')
  }
  if (manifest.protocol !== undefined && !['ssh-socks', 'vless-reality'].includes(manifest.protocol)) {
    throw new PackageReject('PACKAGE_PROTOCOL_INVALID')
  }

  // 凭据 / 文件引用形态:只允许 credentials/<名>、hostkey.pub、overlay.json。
  for (const path of Object.keys(manifest.files)) {
    if (!CREDENTIAL_PATH_PATTERN.test(path) && !ALLOWED_TOP.has(path)) {
      throw new PackageReject('PACKAGE_CREDENTIAL_ESCAPE')
    }
  }

  // 内容清单:列出的必须存在且 sha256 相符;包内非 manifest 文件必须全部被列出。
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  for (const [path, expectedHash] of Object.entries(manifest.files)) {
    const entry = byPath.get(path)
    if (entry === undefined || sha256Hex(entry.data) !== expectedHash) {
      throw new PackageReject('PACKAGE_CONTENT_HASH_MISMATCH')
    }
  }
  for (const entry of entries) {
    if (entry.path !== 'manifest.json' && !(entry.path in manifest.files)) {
      throw new PackageReject('PACKAGE_CONTENT_HASH_MISMATCH')
    }
  }
  const digest = packageDigest(entries)

  if (manifest.issuer !== ISSUER_ID) {
    throw new PackageReject('PACKAGE_ISSUER_MISMATCH')
  }
  if (!packagePlatformMatches(manifest.platform, context.runtimePlatform ?? platformForRuntime(process.platform))) {
    throw new PackageReject('PACKAGE_PLATFORM_MISMATCH')
  }
  if (!validNodeHost(manifest.node.host)) {
    throw new PackageReject('PACKAGE_MALFORMED')
  }
  if (!Number.isInteger(manifest.node.port) || manifest.node.port < 1 || manifest.node.port > 65535) {
    throw new PackageReject('PACKAGE_PORT_INVALID')
  }
  validateNodeList(manifest)

  // hostkey.pub:known_hosts 行「主机 算法 密钥」;主机名须与 manifest 一致,指纹须与清单一致。
  let hostKeyLine = ''
  if (manifest.protocol === 'vless-reality') {
    try {
      // 多入口:每个入口可以有自己的凭据(不同 uuid/公钥/shortId),文件名 credentials/vless.json 或 credentials/vless-<名>.json。
      // 白名单仍是白名单——⛔ 放开成「credentials/ 下随便放」,那等于取消了这道闸。
      if (!validVerifyUrl(manifest.verifyUrl) ||
          Object.keys(manifest.files).some((path) => path !== 'overlay.json' && !VLESS_CREDENTIAL_FILE.test(path))) {
        throw new Error('VLESS_CONFIG_INVALID')
      }
      const credentialFiles = new Set(Object.keys(manifest.files).filter((path) => VLESS_CREDENTIAL_FILE.test(path)))
      if (!credentialFiles.has('credentials/vless.json')) throw new Error('VLESS_CONFIG_INVALID')
      // 每个入口指名的凭据都必须真在包里;每份凭据都要能解析——⛔ 只验第一份,坏的那份要等客户连到它才炸
      for (const node of manifest.nodes ?? []) {
        if (node.credentialFile !== undefined && !credentialFiles.has(`credentials/${node.credentialFile}`)) throw new Error('VLESS_CONFIG_INVALID')
        if (node.verifyUrl !== undefined && !validVerifyUrl(node.verifyUrl)) throw new Error('VLESS_CONFIG_INVALID')
      }
      for (const path of credentialFiles) {
        const credential = byPath.get(path)
        if (!credential) throw new Error('VLESS_CONFIG_INVALID')
        parseVlessCredential(JSON.parse(credential.data.toString('utf8')))
      }
    } catch { throw new PackageReject('PACKAGE_PROTOCOL_INVALID') }
  } else {
    const hostKeyEntry = byPath.get('hostkey.pub')
    if (hostKeyEntry === undefined) {
      throw new PackageReject('PACKAGE_HOST_FINGERPRINT_MISSING')
    }
    hostKeyLine = hostKeyEntry.data.toString('utf8').trim()
    const [keyHost, , keyBase64] = hostKeyLine.split(/\s+/)
    const expectedKeyHost = manifest.node.port === 22 ? manifest.node.host : `[${manifest.node.host}]:${manifest.node.port}`
    if (keyHost !== expectedKeyHost) {
      throw new PackageReject('PACKAGE_NODE_HOST_MISMATCH')
    }
    const fingerprintField = (manifest.node as Record<string, unknown>).hostKeyFingerprint
    if (typeof fingerprintField !== 'string' || fingerprintField === '') {
      throw new PackageReject('PACKAGE_HOST_FINGERPRINT_MISSING')
    }
    if (hostKeyFingerprintOf(keyBase64 ?? '') !== fingerprintField) {
      throw new PackageReject('PACKAGE_HOST_FINGERPRINT_MISMATCH')
    }

    const sshUserField = (manifest.node as Record<string, unknown>).sshUser
    if (typeof sshUserField !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(sshUserField)) {
      throw new PackageReject('PACKAGE_SSH_USER_MISSING')
    }
  }

  const credentialPaths = Object.keys(manifest.files).filter((path) => path.startsWith('credentials/'))
  if (credentialPaths.length === 0) {
    throw new PackageReject('PACKAGE_CREDENTIAL_ESCAPE')
  }

  const expiresAt = Date.parse(manifest.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= context.now) {
    throw new PackageReject('PACKAGE_EXPIRED')
  }
  const issuedAt = Date.parse(manifest.issuedAt)
  if (!Number.isFinite(issuedAt) || issuedAt > context.now || issuedAt >= expiresAt) {
    throw new PackageReject('PACKAGE_MALFORMED')
  }
  if (!AUTH_ID_PATTERN.test(manifest.authorizationId)) {
    throw new PackageReject('PACKAGE_AUTH_ID_INVALID')
  }
  if (
    context.currentAuthorizationId !== undefined &&
    manifest.authorizationId !== context.currentAuthorizationId
  ) {
    throw new PackageReject('PACKAGE_AUTH_ID_MISMATCH')
  }
  if (context.currentVersion !== undefined && manifest.configVersion < context.currentVersion) {
    throw new PackageReject('PACKAGE_VERSION_REGRESSION')
  }

  const overlay = parseOverlay(byPath.get('overlay.json'))

  const trust = evaluateTrust(
    {
      signatureBase64: manifest.signature,
      payload: canonicalManifestPayload(manifest),
      packageDigest: digest
    },
    context.trust
  )
  if (overlay?.directDomains !== undefined && trust.tier !== 'signed-issuer') {
    throw new PackageReject('PACKAGE_OVERLAY_NOT_ALLOWED')
  }
  if (context.currentAuthorizationId !== undefined && context.currentVersion !== undefined &&
      context.currentPackageDigest !== undefined && manifest.authorizationId === context.currentAuthorizationId &&
      manifest.configVersion === context.currentVersion && digest !== context.currentPackageDigest) {
    throw new PackageReject('PACKAGE_VERSION_CONFLICT')
  }

  return {
    manifest,
    trust,
    packageDigest: digest,
    credentialPaths,
    hostKeyLine,
    overlay
  }
}

function parseOverlay(entry: PackageEntry | undefined): ValidatedPackage['overlay'] {
  if (entry === undefined) {
    return undefined
  }
  if (entry.data.length > 64 * 1024) throw new PackageReject('PACKAGE_OVERLAY_NOT_ALLOWED')
  let parsed: unknown
  try {
    parsed = JSON.parse(entry.data.toString('utf8'))
  } catch {
    throw new PackageReject('PACKAGE_MALFORMED')
  }
  return validateRouteOverlay(parsed)
}

/** Validate a route supplement without reading package files; the issuer and channel definition reuse this guard. */
export function validateRouteOverlay(input: unknown): RouteOverlay {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PackageReject('PACKAGE_OVERLAY_NOT_ALLOWED')
  }
  const keys = Object.keys(input)
  if (!keys.length || keys.some((key) => !['tunnelDomains', 'directDomains'].includes(key))) {
    throw new PackageReject('PACKAGE_OVERLAY_NOT_ALLOWED')
  }
  const value = input as Record<string, unknown>
  const tunnelDomains = value.tunnelDomains ?? []
  const directDomains = value.directDomains ?? []
  if (!Array.isArray(tunnelDomains) || !Array.isArray(directDomains) ||
      keys.some((key) => value[key] === null) || tunnelDomains.length + directDomains.length > 256 ||
      [...tunnelDomains, ...directDomains].some((domain) => !validRuleDomain(domain))) {
    throw new PackageReject('PACKAGE_OVERLAY_NOT_ALLOWED')
  }
  if ([...tunnelDomains, ...directDomains].some((domain) => PROTECTED_DIRECT_SUFFIXES.some((suffix) => overlaps(domain, suffix))) ||
      directDomains.some((domain) => tunnelDomains.some((tunnel) => overlaps(domain, tunnel)))) {
    throw new PackageReject('PACKAGE_OVERLAY_NOT_ALLOWED')
  }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new PackageReject('PACKAGE_OVERLAY_NOT_ALLOWED')
  }
  if (serialized === undefined || Buffer.byteLength(`${serialized}\n`, 'utf8') > 64 * 1024) {
    throw new PackageReject('PACKAGE_OVERLAY_NOT_ALLOWED')
  }
  return {
    tunnelDomains: [...tunnelDomains],
    ...(keys.includes('directDomains') ? { directDomains: [...directDomains] } : {})
  }
}
