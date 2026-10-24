import { describe, expect, it } from 'vitest'
import { loadCatalog, parseCatalog } from '../../app/main/download/catalog'

// RETIRE03:下载引擎退役后目录只承载 external-entry;本文件守解析防御与「download 型不得回流」。
const validCatalog = {
  catalogVersion: 'fixture',
  resources: [
    {
      id: 'codex-official-download',
      software: 'Codex',
      platform: 'macos',
      architecture: 'arm64',
      type: 'external-entry',
      officialPageUrl: 'https://learn.chatgpt.com/docs/app',
      allowedHosts: ['learn.chatgpt.com'],
      version: '0.6.2',
      officialVersionLabel: 'Codex for Mac',
      approval: {
        approvedAt: '2026-09-07T16:03:25+08:00',
        approvedBy: 'fixture',
        sourceBuild: 'fixture',
        scope: '核准这一次下载的那个包'
      }
    },
    {
      id: 'hermes-github',
      software: 'Hermes',
      platform: 'windows',
      architecture: 'x86_64',
      type: 'external-entry',
      officialPageUrl: 'https://github.com/nousresearch/hermes/releases',
      allowedHosts: ['github.com'],
      version: '0.21.0',
      officialVersionLabel: 'Hermes Agent',
      approval: {
        approvedAt: '2026-09-07T01:36:30+08:00',
        approvedBy: 'fixture',
        sourceBuild: 'fixture',
        scope: '核准这一次下载的那个包'
      }
    }
  ]
}

describe('静态资源目录(external-entry)', () => {
  it('解析完整、已核准的官方入口条目', () => {
    const catalog = parseCatalog(validCatalog)
    expect(catalog.catalogVersion).toBe('fixture')
    expect(catalog.resources[0]).toMatchObject({ id: 'codex-official-download', type: 'external-entry', officialVersionLabel: 'Codex for Mac' })
    expect(catalog.resources[1]).toMatchObject({ software: 'Hermes', platform: 'windows', architecture: 'x86_64' })
  })

  it('⛔ download 型条目(引擎已退役)与未知类型一律拒绝,带不带下载字段都一样', () => {
    for (const type of ['download', 'mirror', '']) {
      const retired = structuredClone(validCatalog)
      ;(retired.resources[0] as Record<string, unknown>).type = type
      expect(() => parseCatalog(retired)).toThrow('CATALOG_RESOURCE_INVALID')
    }
    const withEngineFields = structuredClone(validCatalog)
    Object.assign(withEngineFields.resources[0], {
      type: 'download',
      assetUrl: 'https://learn.chatgpt.com/docs/Codex.dmg',
      format: 'dmg',
      expectedBytes: '1',
      officialSha256: null,
      recordedSha256: 'a'.repeat(64)
    })
    expect(() => parseCatalog(withEngineFields)).toThrow('CATALOG_RESOURCE_INVALID')
  })

  it('缺核准字段、缺 scope 或 id 形如地址都被拒绝', () => {
    const missingApproval = structuredClone(validCatalog)
    delete (missingApproval.resources[0] as { approval?: unknown }).approval
    expect(() => parseCatalog(missingApproval)).toThrow('CATALOG_RESOURCE_INVALID')

    const missingScope = structuredClone(validCatalog)
    delete (missingScope.resources[0].approval as unknown as Record<string, unknown>).scope
    expect(() => parseCatalog(missingScope)).toThrow('CATALOG_RESOURCE_INVALID')

    const directUrl = structuredClone(validCatalog)
    directUrl.resources[0].id = 'https://example.invalid/installer.dmg'
    expect(() => parseCatalog(directUrl)).toThrow('CATALOG_RESOURCE_INVALID')
  })

  it('外部安装入口必须是无凭据、无片段且主机在白名单内的 HTTPS 页面', () => {
    for (const page of [
      'http://learn.chatgpt.com/docs/app',
      'https://unlisted.example/download',
      'https://person:password@learn.chatgpt.com/docs/app',
      'https://learn.chatgpt.com/docs/app#fragment'
    ]) {
      const entry = structuredClone(validCatalog)
      entry.resources[0].officialPageUrl = page
      expect(() => parseCatalog(entry)).toThrow('CATALOG_RESOURCE_INVALID')
    }
  })

  it('真目录只含 external-entry 且整包可解析', () => {
    const catalog = loadCatalog()
    expect(catalog.resources.length).toBeGreaterThan(0)
    expect(catalog.resources.every((resource) => resource.type === 'external-entry')).toBe(true)
  })
})
