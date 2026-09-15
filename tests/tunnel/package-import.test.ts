import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importConfig, type ImportDeps, type ImportOutcome } from '../../app/main/tunnel/import-service'
import { REJECT_REASONS, type RejectCode } from '../../app/main/tunnel/package-format'
import { layout } from '../../app/main/tunnel/paths'
import { applyPending } from '../../app/main/tunnel/transactions'
import { loadTrustContext, TRUST_LINES, type TrustContext } from '../../app/main/tunnel/trust'
import { buildPackageEntries, makeTestKeyPair, writePackageDir, type BuiltPackage } from './fixtures/package-builder'
import { tarFromPackageEntries, writeTar } from './fixtures/tar-writer'
import { makeTempDir, removeTempDir } from './helpers'

const NOW = Date.parse('2026-10-01T00:00:00Z')

// 收集所有 fixture 产出的字符串,供判据 15 反向 grep
const producedStrings: string[] = []

function recordStrings(outcome: ImportOutcome): void {
  producedStrings.push(JSON.stringify(outcome))
}

describe('配置包导入与信任三档(判据 6/12/14/15/16)', () => {
  let dataDir: string
  let packageDir: string
  let whitelistTrust: TrustContext // 测试构建:白名单由 env 注入
  const keyPair = makeTestKeyPair()

  beforeEach(() => {
    dataDir = makeTempDir('laixin-import-')
    packageDir = makeTempDir('laixin-package-')
    whitelistTrust = { whitelistDigests: [], signingPublicKeys: [] }
  })

  afterEach(() => {
    removeTempDir(dataDir)
    removeTempDir(packageDir)
  })

  function depsFor(packagePath: string | undefined, trust: TrustContext): ImportDeps {
    return {
      dataDir,
      picker: () => Promise.resolve(packagePath),
      trust,
      now: () => NOW,
      sourceLineOf: (validated) => TRUST_LINES[validated.trust.tier]
    }
  }

  function trustFor(built: BuiltPackage, signed = false): TrustContext {
    return {
      whitelistDigests: signed ? [] : [built.digest],
      signingPublicKeys: signed ? [keyPair.publicKey] : []
    }
  }

  async function importBuilt(built: BuiltPackage, trust?: TrustContext): Promise<ImportOutcome> {
    const dir = writePackageDir(join(packageDir, `pkg-${producedStrings.length}`), built)
    const outcome = await importConfig(depsFor(dir, trust ?? trustFor(built)))
    recordStrings(outcome)
    return outcome
  }

  function assertNoResidue(): void {
    expect(existsSync(layout.imports(dataDir)) ? readdirSync(layout.imports(dataDir)) : []).toEqual([])
    expect(existsSync(layout.staging(dataDir)) ? readdirSync(layout.staging(dataDir)) : []).toEqual([])
    expect(existsSync(layout.pendingPointer(dataDir))).toBe(false)
  }

  it('判据 12 正向:测试构建 + 白名单含该包摘要 → 落 pending、凭据 0600、摘要脱敏、来源行逐字', async () => {
    const built = buildPackageEntries() // 端口缺省 22(合法,反向:⛔ 把 22 拒了)
    const outcome = await importBuilt(built)
    if (outcome.outcome !== 'imported') {
      throw new Error(`预期 imported,实际 ${JSON.stringify(outcome)}`)
    }
    expect(outcome.sourceLine).toBe('来源:未签名(内部测试包)')
    expect(outcome.authorizationId).toBe('lx-test0001')
    expect(outcome.nodeLabel).toBe('node-a.test.invalid:22')
    expect(existsSync(join(layout.batchDir(dataDir, outcome.batchId), 'manifest.json'))).toBe(true)
    const credentialMode =
      statSync(join(layout.batchDir(dataDir, outcome.batchId), 'credentials', 'id_ed25519')).mode & 0o777
    expect(credentialMode).toBe(0o600)
    expect(existsSync(layout.currentPointer(dataDir))).toBe(false) // current 一字节不动
    expect(readPending()).toBe(outcome.batchId)
    // 摘要脱敏:输出里 grep 不到凭据内容
    expect(JSON.stringify(outcome)).not.toContain('FAKE-TEST-PRIVATE-KEY')
  })

  it('判据 12 反向:客户构建(无白名单)下同一未签名包 → 拒绝', async () => {
    const built = buildPackageEntries()
    const outcome = await importBuilt(built, { whitelistDigests: [], signingPublicKeys: [] })
    expect(outcome).toMatchObject({ outcome: 'rejected', code: 'PACKAGE_UNSIGNED_UNTRUSTED' })
    assertNoResidue()
  })

  it('「已签名」fixture(测试密钥对,标「测试密钥」):验签通过 → imported;验签失败 / 无公钥 → 拒绝', async () => {
    const signed = buildPackageEntries({ signWith: keyPair.privateKey })
    const ok = await importBuilt(signed, trustFor(signed, true))
    if (ok.outcome !== 'imported') {
      throw new Error(`预期 imported,实际 ${JSON.stringify(ok)}`)
    }
    expect(ok.sourceLine).toBe('来源:已签名(测试密钥)')

    const tampered = buildPackageEntries({ signature: Buffer.from('forged-signature').toString('base64') })
    const noKey = await importBuilt(tampered, { whitelistDigests: [], signingPublicKeys: [] })
    expect(noKey).toMatchObject({ outcome: 'rejected', code: 'PACKAGE_SIGNATURE_NO_KEY' })

    const badSignature = buildPackageEntries({ signWith: makeTestKeyPair().privateKey })
    const invalid = await importBuilt(badSignature, trustFor(badSignature, true))
    expect(invalid).toMatchObject({ outcome: 'rejected', code: 'PACKAGE_SIGNATURE_INVALID' })
  })

  it('环境装载:白名单与测试公钥只来自 TOOLBOX_TEST_* 环境变量(测试构建)', () => {
    const ctx = loadTrustContext({
      TOOLBOX_TEST_PACKAGE_WHITELIST: 'aa,bb',
      TOOLBOX_TEST_SIGNING_PUBLIC_KEY: keyPair.publicKeyBase64
    } as NodeJS.ProcessEnv, { allowTestKeys: true })
    expect(ctx.whitelistDigests).toEqual(['aa', 'bb'])
    expect(ctx.signingPublicKeys).toHaveLength(1)
    const empty = loadTrustContext({} as NodeJS.ProcessEnv)
    expect(empty.whitelistDigests).toEqual([])
    expect(empty.signingPublicKeys).toEqual([])
  })

  it('判据 6/14 拒绝 fixture 矩阵:每种一个,各自「拒绝 + 原因码」,数据目录无残留', async () => {
    const cases: Array<{ name: string; build: () => BuiltPackage; code: RejectCode; trust?: TrustContext }> = [
      { name: '签发方标识不对', build: () => buildPackageEntries({ issuer: 'evil-issuer' }), code: 'PACKAGE_ISSUER_MISMATCH' },
      { name: '平台不符', build: () => buildPackageEntries({ platform: 'win' }), code: 'PACKAGE_PLATFORM_MISMATCH' },
      {
        name: '节点主机与 manifest 不一致',
        build: () => buildPackageEntries({ hostKeyHost: 'other.test.invalid' }),
        code: 'PACKAGE_NODE_HOST_MISMATCH'
      },
      { name: '端口 0', build: () => buildPackageEntries({ port: 0 }), code: 'PACKAGE_PORT_INVALID' },
      { name: '端口 65536', build: () => buildPackageEntries({ port: 65536 }), code: 'PACKAGE_PORT_INVALID' },
      { name: '缺指纹', build: () => buildPackageEntries({ fingerprint: '' }), code: 'PACKAGE_HOST_FINGERPRINT_MISSING' },
      {
        name: '主机指纹与清单不符',
        build: () => buildPackageEntries({ fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
        code: 'PACKAGE_HOST_FINGERPRINT_MISMATCH'
      },
      { name: '缺 SSH 用户名', build: () => buildPackageEntries({ sshUser: '' }), code: 'PACKAGE_SSH_USER_MISSING' },
      {
        name: '凭据引用逃出批次目录',
        build: () =>
          buildPackageEntries({
            manifestMutate: (manifest) => {
              ;(manifest.files as Record<string, string>)['../escape.key'] = '0'.repeat(64)
            }
          }),
        code: 'PACKAGE_CREDENTIAL_ESCAPE'
      },
      { name: '已过期', build: () => buildPackageEntries({ expiresAt: '2026-09-01T00:00:00Z' }), code: 'PACKAGE_EXPIRED' },
      {
        name: '授权 id 格式不合',
        build: () => buildPackageEntries({ authorizationId: '随便什么 id' }),
        code: 'PACKAGE_AUTH_ID_INVALID'
      },
      {
        name: '清单 sha256 不符',
        build: () =>
          buildPackageEntries({
            manifestMutate: (manifest) => {
              ;(manifest.files as Record<string, string>)['hostkey.pub'] = '0'.repeat(64)
            }
          }),
        code: 'PACKAGE_CONTENT_HASH_MISMATCH'
      },
      {
        name: '分流覆盖放宽(含直连例外键)',
        build: () =>
          buildPackageEntries({
            extraFiles: { 'overlay.json': JSON.stringify({ directDomains: ['evil.example'] }) }
          }),
        code: 'PACKAGE_OVERLAY_NOT_ALLOWED'
      },
      {
        name: '分流覆盖碰 DeepSeek 直连例外',
        build: () =>
          buildPackageEntries({
            extraFiles: { 'overlay.json': JSON.stringify({ tunnelDomains: ['deepseek.com'] }) }
          }),
        code: 'PACKAGE_OVERLAY_NOT_ALLOWED'
      }
    ]
    for (const fixture of cases) {
      const outcome = await importBuilt(fixture.build(), fixture.trust)
      expect(outcome, fixture.name).toMatchObject({ outcome: 'rejected', code: fixture.code })
      expect(outcome.outcome === 'rejected' && outcome.message).toBe(REJECT_REASONS[fixture.code])
    }
    assertNoResidue()
  })

  it('无 manifest / 包损坏 → 拒绝', async () => {
    const noManifest = buildPackageEntries({ manifestMutate: () => undefined })
    const entries = noManifest.entries.filter((entry) => entry.path !== 'manifest.json')
    const tarPath = join(packageDir, 'no-manifest.lxtpack')
    writeFileSync(tarPath, tarFromPackageEntries(entries))
    const outcome = await importConfig(depsFor(tarPath, whitelistTrust))
    recordStrings(outcome)
    expect(outcome).toMatchObject({ outcome: 'rejected', code: 'PACKAGE_MANIFEST_MISSING' })

    const brokenPath = join(packageDir, 'broken.lxtpack')
    writeFileSync(brokenPath, Buffer.from('这不是 tar 包内容'))
    const malformed = await importConfig(depsFor(brokenPath, whitelistTrust))
    recordStrings(malformed)
    expect(malformed).toMatchObject({ outcome: 'rejected', code: 'PACKAGE_MANIFEST_MISSING' })
  })

  it('所属客户不符:current 已有 lx-test0001,新包载明别的授权 id → 拒绝', async () => {
    const first = buildPackageEntries({ configVersion: 2 })
    const firstOutcome = await importBuilt(first)
    if (firstOutcome.outcome !== 'imported') {
      throw new Error('首个包导入应成功')
    }
    expect(applyPending(dataDir)).toMatchObject({ outcome: 'applied' })

    const otherCustomer = buildPackageEntries({ configVersion: 3, authorizationId: 'lx-other99' })
    const outcome = await importBuilt(otherCustomer)
    expect(outcome).toMatchObject({ outcome: 'rejected', code: 'PACKAGE_AUTH_ID_MISMATCH' })
  })

  it('版本倒退:current 版本 2,导入版本 1 → 拒绝;更高版本 → 通过', async () => {
    const v2 = buildPackageEntries({ configVersion: 2 })
    const v2Outcome = await importBuilt(v2)
    if (v2Outcome.outcome !== 'imported') {
      throw new Error('v2 导入应成功')
    }
    expect(applyPending(dataDir)).toMatchObject({ outcome: 'applied' })

    const v1 = await importBuilt(buildPackageEntries({ configVersion: 1 }))
    expect(v1).toMatchObject({ outcome: 'rejected', code: 'PACKAGE_VERSION_REGRESSION' })

    const v3 = buildPackageEntries({ configVersion: 3 })
    const v3Outcome = await importBuilt(v3)
    expect(v3Outcome.outcome).toBe('imported')
  })

  it('同一授权同版本只允许完全相同包重复导入，签名有效的不同内容仍拒绝', async () => {
    const accepted = buildPackageEntries({ configVersion: 2, signWith: keyPair.privateKey })
    const trust = trustFor(accepted, true)
    const first = await importBuilt(accepted, trust)
    expect(first.outcome).toBe('imported')
    expect(applyPending(dataDir)).toMatchObject({ outcome: 'applied' })

    const repeated = await importBuilt(accepted, trust)
    expect(repeated.outcome).toBe('imported')
    expect(applyPending(dataDir)).toMatchObject({ outcome: 'applied' })

    const replacement = buildPackageEntries({ configVersion: 2, signWith: keyPair.privateKey })
    const rejected = await importBuilt(replacement, trust)
    expect(rejected).toMatchObject({ outcome: 'rejected', code: 'PACKAGE_VERSION_CONFLICT' })
  })

  it('判据 16 解包安全:../、绝对路径、符号链接、重名四个恶意包 → 解包前拒绝,批次目录为空', async () => {
    const malicious: Array<{ name: string; entries: Parameters<typeof writeTar>[0] }> = [
      { name: '越界路径', entries: [{ name: '../evil.txt', data: Buffer.from('x') }] },
      { name: '绝对路径', entries: [{ name: '/etc/evil.txt', data: Buffer.from('x') }] },
      {
        name: '符号链接',
        entries: [{ name: 'link', data: Buffer.from(''), typeflag: '2' }]
      },
      {
        name: '重名条目',
        entries: [
          { name: 'dup.txt', data: Buffer.from('a') },
          { name: 'dup.txt', data: Buffer.from('b') }
        ]
      }
    ]
    for (const fixture of malicious) {
      const tarPath = join(packageDir, `malicious-${fixture.name}.lxtpack`)
      writeFileSync(tarPath, writeTar(fixture.entries))
      const outcome = await importConfig(depsFor(tarPath, whitelistTrust))
      recordStrings(outcome)
      expect(outcome, fixture.name).toMatchObject({ outcome: 'rejected', code: 'PACKAGE_ENTRY_UNSAFE' })
    }
    assertNoResidue()
  })

  it('判据 15 反向:所有 fixture 输出 grep 不到「已授权」「可信」「已认证」;「已签名」只在验签通过 fixture 且标「测试密钥」', () => {
    const all = [...producedStrings, ...Object.values(REJECT_REASONS), ...Object.values(TRUST_LINES)]
    const forbidden = /已授权|可信|已认证/
    for (const text of all) {
      expect(text, `禁词出现在:${text}`).not.toMatch(forbidden)
    }
    // 「已签名」字样只能出现在验签通过 fixture 的输出里,且必须标「测试密钥」
    const outcomeMentions = producedStrings.filter((text) => text.includes('已签名'))
    expect(outcomeMentions.length).toBeGreaterThan(0)
    expect(outcomeMentions.every((text) => text.includes('测试密钥'))).toBe(true)
    expect(Object.values(REJECT_REASONS).some((text) => text.includes('已签名'))).toBe(false)
    // 反向:验签通过 fixture 的输出确实出现过该字样(⛔ 从不出现也算过)
    expect(producedStrings.some((text) => text.includes('来源:已签名(测试密钥)'))).toBe(true)
  })

  function readPending(): string | undefined {
    if (!existsSync(layout.pendingPointer(dataDir))) {
      return undefined
    }
    const content = readFileSync(layout.pendingPointer(dataDir), 'utf8').trim()
    return content === '' ? undefined : content
  }
})
