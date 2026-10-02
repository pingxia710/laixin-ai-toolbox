import rawCatalog from '../../../resources/catalog.json'
import { isPlatform, isSoftwareId } from '../precheck/software-platform'
import type { DownloadArchitecture, DownloadCatalog, DownloadResource, ResourceApproval } from './types'

// 静态目录整包 parse+validate 只做一次,⛔ 每次访问重复解析校验。
let cachedCatalog: DownloadCatalog | undefined

export function loadCatalog(): DownloadCatalog {
  if (cachedCatalog === undefined) cachedCatalog = parseCatalog(rawCatalog)
  return cachedCatalog
}

export function parseCatalog(value: unknown): DownloadCatalog {
  if (!isRecord(value) || !isNonEmptyString(value.catalogVersion) || !Array.isArray(value.resources)) {
    throw new Error('CATALOG_INVALID')
  }
  const resources = value.resources.map(parseResource)
  if (resources.length === 0 || new Set(resources.map((resource) => resource.id)).size !== resources.length) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }
  return { catalogVersion: value.catalogVersion, resources }
}

// RETIRE03:下载引擎已退役,目录只承载 external-entry(到官方下载页);⛔ download 型条目回流。
function parseResource(value: unknown): DownloadResource {
  if (!isRecord(value)) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }
  const id = stringField(value, 'id')
  const software = stringField(value, 'software')
  const platform = stringField(value, 'platform')
  const architecture = stringField(value, 'architecture')
  const officialPageUrl = stringField(value, 'officialPageUrl')
  const allowedHosts = stringArrayField(value, 'allowedHosts')
  const approval = parseApproval(value.approval)

  if (
    value.type !== 'external-entry' ||
    !/^[a-z][a-z0-9-]{1,99}$/.test(id) ||
    !isCatalogSoftwareId(software) ||
    !isPlatform(platform) ||
    !isDownloadArchitecture(architecture) ||
    !isApprovedExternalPage(officialPageUrl, allowedHosts)
  ) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }

  return {
    id,
    software,
    platform,
    architecture,
    type: 'external-entry',
    officialPageUrl,
    allowedHosts,
    version: stringField(value, 'version'),
    officialVersionLabel: stringField(value, 'officialVersionLabel'),
    approval
  }
}

function parseApproval(value: unknown): ResourceApproval {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.approvedAt) ||
    !isNonEmptyString(value.approvedBy) ||
    !isNonEmptyString(value.sourceBuild) ||
    !isNonEmptyString(value.scope)
  ) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }
  return { approvedAt: value.approvedAt, approvedBy: value.approvedBy, sourceBuild: value.sourceBuild, scope: value.scope }
}

function isCatalogSoftwareId(value: string): boolean {
  return isSoftwareId(value.toLowerCase())
}

function isDownloadArchitecture(value: unknown): value is DownloadArchitecture {
  return typeof value === 'string' && value !== 'unknown' && /^[a-z][a-z0-9_-]*$/.test(value)
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field]
  if (!isNonEmptyString(candidate)) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }
  return candidate
}

function stringArrayField(value: Record<string, unknown>, field: string): readonly string[] {
  const candidate = value[field]
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.some((entry) => !isNonEmptyString(entry))) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }
  return candidate
}

function isApprovedExternalPage(value: string, allowedHosts: readonly string[]): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && allowedHosts.includes(url.hostname)
  } catch {
    return false
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
