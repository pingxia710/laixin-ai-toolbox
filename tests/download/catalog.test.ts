import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { loadCatalog, parseCatalog } from '../../app/main/download/catalog'

const execFileAsync = promisify(execFile)

const validCatalog = {
  catalogVersion: '1',
  resources: [
    {
      id: 'hermes-macos-arm64',
      software: 'Hermes',
      platform: 'macos',
      architecture: 'arm64',
      type: 'download',
      officialPageUrl: 'https://hermes-agent.nousresearch.com/desktop',
      assetUrl: 'https://hermes-assets.nousresearch.com/Hermes-Setup.dmg?build=06402ecb7ca5',
      allowedHosts: ['hermes-assets.nousresearch.com'],
      version: '0.0.1',
      officialVersionLabel: 'Hermes Agent v0.21.0',
      format: 'dmg',
      expectedBytes: '6752854',
      officialSha256: null,
      recordedSha256: 'b61e047efe3059faf1c55fec3252e661f2d2a993a7a3eebf5cc6a9aa5c1790f5',
      identity: {
        installerBundleIdentifier: 'com.nousresearch.hermes.setup',
        installedBundleIdentifier: null,
        signingSubject: 'Developer ID Application: Brooklyn Nicholson (T2F6S8MF7C)',
        architecture: 'arm64',
        maintenanceNote: '签名核验按 Developer ID 全串 + Team ID 钉死(实测签名主体是个人名 Brooklyn Nicholson,不是组织名)。厂商换签名证书时我们会拒掉正版包——这是一条需要有人维护的条目:换证书后必须实测新证书并更新本条目。'
      },
      approval: {
        approvedAt: '2026-09-07T01:36:30+08:00',
        approvedBy: '本片开发方',
        sourceBuild: '06402ecb7ca5',
        scope: '核准的是这一次下载的那个包(Hermes-Setup.dmg 本身),不是它装出来的版本——官方安装器是下载型 stub,总装当刻最新,装出来的版本钉不住。'
      }
    },
    {
      id: 'codex-macos-arm64',
      software: 'Codex',
      platform: 'macos',
      architecture: 'arm64',
      type: 'download',
      officialPageUrl: 'https://learn.chatgpt.com/docs/app',
      assetUrl: 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg',
      allowedHosts: ['persistent.oaistatic.com'],
      version: '26.901.51231',
      officialVersionLabel: 'Codex for Mac 26.901.51231',
      format: 'dmg',
      expectedBytes: '643007873',
      officialSha256: null,
      recordedSha256: 'b6ffed73d581047862e85de5b4d322ba431004949a5338736e7059182dff6082',
      identity: {
        installerBundleIdentifier: 'com.openai.codex',
        installedBundleIdentifier: 'com.openai.codex',
        signingSubject: 'Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)',
        architecture: 'arm64',
        maintenanceNote: '签名核验按 Developer ID 全串 + Team ID 钉死(实测主体是组织名 OpenAI OpCo, LLC,Team ID 2DC432GLL2)。厂商换签名证书时我们会拒掉正版包——这是一条需要有人维护的条目:换证书后必须实测新证书并更新本条目。'
      },
      approval: {
        approvedAt: '2026-09-07T16:03:25+08:00',
        approvedBy: '方案窗口第五任实测(2026-09-07),下载核验半片开发方录入',
        sourceBuild: '8109',
        scope: '核准的是 26.901.51231 这个版本——Codex 是拖拽型完整包,版本写在包内(CFBundleVersion 8109),与 Hermes 的 stub 不同,版本钉得住;官方发新版时 sha256 随之改变,下载核验会报「官方包已更新」,届时实测新包并更新本条目。功能核准已完成(2026-09-08 真实下载核验、隔离安装、首次启动确认 Codex 界面,记录见交付报告)。'
      }
    }
  ]
}

describe('静态资源目录(Hermes 与 Codex)', () => {
  it('同一个已核准安装包可以有多个直连或通道下载来源', () => {
    const input = structuredClone(validCatalog)
    const sources = [
      { id: 'domestic', network: 'direct', assetUrl: 'https://downloads.example.cn/Hermes.dmg', allowedHosts: ['downloads.example.cn'] },
      { id: 'official', network: 'tunnel', assetUrl: input.resources[0].assetUrl, allowedHosts: input.resources[0].allowedHosts }
    ]
    Object.assign(input.resources[0], { sources })
    expect(parseCatalog(input).resources[0].sources).toEqual(sources)
    for (const bad of [[], [sources[0], sources[0]], [{ ...sources[0], network: 'anything' }], [{ ...sources[0], allowedHosts: ['other.example.cn'] }], [{ ...sources[0], assetUrl: 'http://downloads.example.cn/Hermes.dmg' }]]) {
      Object.assign(input.resources[0], { sources: bad })
      expect(() => parseCatalog(input)).toThrow('CATALOG_SOURCES_INVALID')
    }
  })
  it('冻结实际核到的官方资产、包内版本与页面标签，并明确没有官方摘要', () => {
    const catalog = loadCatalog()
    const { sources, ...resource } = catalog.resources[0]
    expect(resource).toEqual(validCatalog.resources[0])
    expect(sources?.map((source) => source.network)).toEqual(['direct', 'tunnel'])
    expect(sources?.every((source) => source.assetUrl === resource.assetUrl)).toBe(true)

    const { sources: codexSources, ...codexResource } = catalog.resources[1]
    expect(codexResource).toEqual(validCatalog.resources[1])
    // 直连优先 + 通道备用:直连在本类网络会被 DNS 污染/中断,通道已连接时自动作为备用渠道。
    expect(codexSources).toEqual([
      { id: 'official-direct', assetUrl: 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg', allowedHosts: ['persistent.oaistatic.com'], network: 'direct' },
      { id: 'official-tunnel', assetUrl: 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg', allowedHosts: ['persistent.oaistatic.com'], network: 'tunnel' }
    ])
  })

  it('只接受完整、已核准且下载主机与资产地址一致的条目', () => {
    const catalog = parseCatalog(validCatalog)
    expect(catalog.catalogVersion).toBe('1')
    expect(catalog.resources[0]).toMatchObject({
      id: 'hermes-macos-arm64',
      type: 'download',
      version: '0.0.1',
      officialVersionLabel: 'Hermes Agent v0.21.0'
    })
  })

  it('拒绝把地址字符串、跳出的初始主机或未核准条目当作下载目录', () => {
    const escapedHost = structuredClone(validCatalog)
    escapedHost.resources[0].assetUrl = 'https://example.invalid/Hermes-Setup.dmg'
    expect(() => parseCatalog(escapedHost)).toThrow('CATALOG_ASSET_HOST_NOT_ALLOWED')

    const missingApproval = structuredClone(validCatalog)
    delete (missingApproval.resources[0] as { approval?: unknown }).approval
    expect(() => parseCatalog(missingApproval)).toThrow('CATALOG_RESOURCE_INVALID')

    const directUrl = structuredClone(validCatalog)
    directUrl.resources[0].id = 'https://example.invalid/installer.dmg'
    expect(() => parseCatalog(directUrl)).toThrow('CATALOG_RESOURCE_INVALID')
  })

  it('外部安装入口必须是无凭据、无片段且主机在白名单内的 HTTPS 页面', () => {
    const entry = structuredClone(validCatalog)
    const resource = entry.resources[0] as Record<string, unknown>
    Object.assign(resource, {
      id: 'hermes-official-page',
      type: 'external-entry',
      officialPageUrl: 'https://hermes-agent.nousresearch.com/desktop',
      allowedHosts: ['hermes-agent.nousresearch.com']
    })
    delete resource.assetUrl
    delete resource.format
    delete resource.expectedBytes
    delete resource.officialSha256
    delete resource.recordedSha256
    delete resource.identity
    expect(parseCatalog(entry).resources[0]?.type).toBe('external-entry')

    for (const page of [
      'https://unlisted.example/download',
      'https://person:password@hermes-agent.nousresearch.com/desktop',
      'https://hermes-agent.nousresearch.com/desktop#fragment'
    ]) {
      resource.officialPageUrl = page
      expect(() => parseCatalog(entry)).toThrow('CATALOG_RESOURCE_INVALID')
    }
  })

  it('目录条目的旧字段名 bundleIdentifier 与缺核准语义的条目被拒绝', () => {
    const legacyName = structuredClone(validCatalog)
    const legacyIdentity = legacyName.resources[0].identity as unknown as Record<string, unknown>
    legacyIdentity.bundleIdentifier = legacyIdentity.installerBundleIdentifier
    delete legacyIdentity.installerBundleIdentifier
    expect(() => parseCatalog(legacyName)).toThrow('CATALOG_RESOURCE_INVALID')

    const missingScope = structuredClone(validCatalog)
    delete (missingScope.resources[0].approval as unknown as Record<string, unknown>).scope
    expect(() => parseCatalog(missingScope)).toThrow('CATALOG_RESOURCE_INVALID')

    // 「装好之后的标识」必须显式声明(哪怕是 null = 未核),缺键即拒——⛔ 让两种身份语义再长成一个样。
    const missingInstalled = structuredClone(validCatalog)
    delete (missingInstalled.resources[0].identity as unknown as Record<string, unknown>).installedBundleIdentifier
    expect(() => parseCatalog(missingInstalled)).toThrow('CATALOG_RESOURCE_INVALID')
  })

  it('接受非 Hermes / 非 macos / 非 arm64 的资源，并保留 Windows 所需的 exe / msix 格式', () => {
    const catalog = parseCatalog(secondDimensionCatalog())

    expect(catalog.resources[0]).toMatchObject({
      id: 'fixturesoft-windows-x86-64',
      software: 'fixturesoft',
      platform: 'windows',
      architecture: 'x86_64',
      format: 'exe'
    })

    const msixCatalog = secondDimensionCatalog()
    msixCatalog.resources[0].assetUrl = 'https://assets.fixturesoft.invalid/fixturesoft.msix'
    msixCatalog.resources[0].format = 'msix'
    expect(parseCatalog(msixCatalog).resources[0]?.format).toBe('msix')
  })

  it('第二种取值不放松 HTTPS、主机白名单、bundle、签名主体或身份架构校验', () => {
    const insecureOfficialPage = secondDimensionCatalog()
    insecureOfficialPage.resources[0].officialPageUrl = 'http://fixturesoft.invalid/download'
    expect(() => parseCatalog(insecureOfficialPage)).toThrow('CATALOG_RESOURCE_INVALID')

    const escapedAssetHost = secondDimensionCatalog()
    escapedAssetHost.resources[0].assetUrl = 'https://escaped.invalid/fixturesoft.exe'
    expect(() => parseCatalog(escapedAssetHost)).toThrow('CATALOG_ASSET_HOST_NOT_ALLOWED')

    const missingBundle = secondDimensionCatalog()
    missingBundle.resources[0].identity.installerBundleIdentifier = ''
    expect(() => parseCatalog(missingBundle)).toThrow('CATALOG_RESOURCE_INVALID')

    const missingSigningSubject = secondDimensionCatalog()
    missingSigningSubject.resources[0].identity.signingSubject = ''
    expect(() => parseCatalog(missingSigningSubject)).toThrow('CATALOG_RESOURCE_INVALID')

    const mismatchedIdentityArchitecture = secondDimensionCatalog()
    mismatchedIdentityArchitecture.resources[0].identity.architecture = 'arm64'
    expect(() => parseCatalog(mismatchedIdentityArchitecture)).toThrow('CATALOG_RESOURCE_INVALID')
  })

  it('把目录维度改回 Hermes / macos / arm64 单值时，同一假资源会被运行时解析拒绝', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'laixin-toolbox-download-dimensions-'))
    const source = await readFile(resolve('app/main/download/catalog.ts'), 'utf8')
    const marker = "!isCatalogSoftwareId(software) ||\n    !isPlatform(platform) ||\n    !isDownloadArchitecture(architecture)"
    const mutated = source
      .replace("import rawCatalog from '../../../resources/catalog.json'", "const rawCatalog: unknown = { catalogVersion: 'fixture', resources: [] }")
      .replace(marker, "software !== 'Hermes' ||\n    platform !== 'macos' ||\n    architecture !== 'arm64'")

    expect(mutated).not.toBe(source)
    try {
      await mkdir(join(temporaryRoot, 'app/main/download'), { recursive: true })
      await mkdir(join(temporaryRoot, 'app/main/precheck'), { recursive: true })
      await writeFile(join(temporaryRoot, 'app/main/download/catalog.ts'), mutated)
      await writeFile(join(temporaryRoot, 'app/main/download/types.ts'), await readFile(resolve('app/main/download/types.ts'), 'utf8'))
      await writeFile(join(temporaryRoot, 'app/main/precheck/software-platform.ts'), await readFile(resolve('app/main/precheck/software-platform.ts'), 'utf8'))
      await writeFile(join(temporaryRoot, 'app/main/precheck/software-platform-owner.ts'), await readFile(resolve('app/main/precheck/software-platform-owner.ts'), 'utf8'))
      await writeFile(join(temporaryRoot, 'app/main/precheck/types.ts'), await readFile(resolve('app/main/precheck/types.ts'), 'utf8'))

      await execFileAsync(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--outDir', join(temporaryRoot, 'out'),
        '--rootDir', temporaryRoot,
        '--strict',
        '--target', 'ES2022',
        '--module', 'CommonJS',
        '--moduleResolution', 'Node',
        '--ignoreDeprecations', '6.0',
        '--esModuleInterop',
        '--typeRoots', resolve('node_modules/@types'),
        '--types', 'node',
        join(temporaryRoot, 'app/main/download/catalog.ts')
      ]).catch((error: unknown) => {
        throw new Error(commandOutput(error))
      })

      const require = createRequire(import.meta.url)
      const { parseCatalog: parseSingleDimensionCatalog } = require(join(temporaryRoot, 'out/app/main/download/catalog.js')) as { readonly parseCatalog: typeof parseCatalog }
      expect(() => parseSingleDimensionCatalog(secondDimensionCatalog())).toThrow('CATALOG_RESOURCE_INVALID')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 20_000)
})

function secondDimensionCatalog() {
  return {
    catalogVersion: 'fixture',
    resources: [
      {
        id: 'fixturesoft-windows-x86-64',
        software: 'fixturesoft',
        platform: 'windows',
        architecture: 'x86_64',
        type: 'download',
        officialPageUrl: 'https://fixturesoft.invalid/download',
        assetUrl: 'https://assets.fixturesoft.invalid/fixturesoft.exe',
        allowedHosts: ['assets.fixturesoft.invalid'],
        version: '0.0.0',
        officialVersionLabel: 'fixturesoft 0.0.0',
        format: 'exe',
        expectedBytes: '1',
        officialSha256: null,
        recordedSha256: 'a'.repeat(64),
        identity: {
          installerBundleIdentifier: 'fixturesoft.desktop',
          installedBundleIdentifier: 'fixturesoft.desktop.installed',
          signingSubject: 'fixturesoft signing subject',
          architecture: 'x86_64'
        },
        approval: {
          approvedAt: '2026-09-07T00:00:00+08:00',
          approvedBy: 'fixture',
          sourceBuild: 'fixture',
          scope: '核准这一次下载的那个包'
        }
      }
    ]
  }
}

function commandOutput(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const output = error as { stdout?: unknown; stderr?: unknown }
  return `${String(output.stdout ?? '')}${String(output.stderr ?? '')}`
}
