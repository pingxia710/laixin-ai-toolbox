import rawCatalog from '../../../resources/catalog.json'
import { isPlatform, isSoftwareId } from '../precheck/software-platform'
import type { DownloadArchitecture, DownloadCatalog, DownloadFormat, DownloadResource, DownloadResourceType, DownloadSource, ExpectedIdentity, ResourceApproval } from './types'

const supportedFormats = new Set<DownloadFormat>(['dmg', 'zip', 'pkg', 'exe', 'msix'])

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

function parseResource(value: unknown): DownloadResource {
  if (!isRecord(value)) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }
  const id = stringField(value, 'id')
  const software = stringField(value, 'software')
  const platform = stringField(value, 'platform')
  const architecture = stringField(value, 'architecture')
  const type = stringField(value, 'type')
  const officialPageUrl = stringField(value, 'officialPageUrl')
  const allowedHosts = stringArrayField(value, 'allowedHosts')
  const version = stringField(value, 'version')
  const officialVersionLabel = stringField(value, 'officialVersionLabel')
  const approval = parseApproval(value.approval)

  if (
    !/^[a-z][a-z0-9-]{1,99}$/.test(id) ||
    !isCatalogSoftwareId(software) ||
    !isPlatform(platform) ||
    !isDownloadArchitecture(architecture) ||
    !isResourceType(type) ||
    !isHttpsUrl(officialPageUrl) ||
    allowedHosts.length === 0
  ) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }

  if (type === 'external-entry') {
    if (!isApprovedExternalPage(officialPageUrl, allowedHosts)) {
      throw new Error('CATALOG_RESOURCE_INVALID')
    }
    return {
      id,
      software,
      platform,
      architecture,
      type,
      officialPageUrl,
      allowedHosts,
      version,
      officialVersionLabel,
      approval
    }
  }

  const assetUrl = stringField(value, 'assetUrl')
  const format = stringField(value, 'format')
  const expectedBytes = stringField(value, 'expectedBytes')
  const officialSha256 = nullableSha256(value.officialSha256)
  const recordedSha256 = sha256Field(value, 'recordedSha256')
  const identity = parseIdentity(value.identity, architecture)
  const sources = value.sources === undefined ? undefined : parseSources(value.sources)
  const assetHost = new URL(assetUrl).hostname
  if (
    !isHttpUrl(assetUrl) ||
    !supportedFormats.has(format as DownloadFormat) ||
    !/^[1-9][0-9]*$/.test(expectedBytes) ||
    !allowedHosts.includes(assetHost)
  ) {
    throw new Error(assetHost !== '' && !allowedHosts.includes(assetHost) ? 'CATALOG_ASSET_HOST_NOT_ALLOWED' : 'CATALOG_RESOURCE_INVALID')
  }

  return {
    id,
    software,
    platform,
    architecture,
    type,
    officialPageUrl,
    assetUrl,
    ...(sources === undefined ? {} : { sources }),
    allowedHosts,
    version,
    officialVersionLabel,
    format: format as DownloadFormat,
    expectedBytes,
    officialSha256,
    recordedSha256,
    identity,
    approval
  }
}

function parseSources(value: unknown): readonly DownloadSource[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('CATALOG_SOURCES_INVALID')
  const sources = value.map((item): DownloadSource => {
    if (!isRecord(item)) throw new Error('CATALOG_SOURCES_INVALID')
    const id = stringField(item, 'id')
    const assetUrl = stringField(item, 'assetUrl')
    const allowedHosts = stringArrayField(item, 'allowedHosts')
    let url: URL
    try { url = new URL(assetUrl) } catch { throw new Error('CATALOG_SOURCES_INVALID') }
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(id) || !['direct', 'tunnel'].includes(String(item.network)) ||
        url.username || url.password || url.hash || !allowedHosts.includes(url.hostname) ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('CATALOG_SOURCES_INVALID')
    }
    return { id, assetUrl, allowedHosts, network: item.network as DownloadSource['network'] }
  })
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error('CATALOG_SOURCES_INVALID')
  return sources
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

function parseIdentity(value: unknown, architecture: DownloadArchitecture): ExpectedIdentity | null {
  if (value === null) {
    return null
  }
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.installerBundleIdentifier) ||
    !('installedBundleIdentifier' in value) ||
    !(value.installedBundleIdentifier === null || isNonEmptyString(value.installedBundleIdentifier)) ||
    !isNonEmptyString(value.signingSubject) ||
    !isDownloadArchitecture(value.architecture) ||
    value.architecture !== architecture ||
    (value.maintenanceNote !== undefined && !isNonEmptyString(value.maintenanceNote))
  ) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }
  return {
    installerBundleIdentifier: value.installerBundleIdentifier,
    installedBundleIdentifier: value.installedBundleIdentifier,
    signingSubject: value.signingSubject,
    architecture: value.architecture,
    ...(value.maintenanceNote === undefined ? {} : { maintenanceNote: value.maintenanceNote })
  }
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

function nullableSha256(value: unknown): string | null {
  if (value === null) {
    return null
  }
  return sha256Value(value)
}

function sha256Field(value: Record<string, unknown>, field: string): string {
  return sha256Value(value[field])
}

function sha256Value(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('CATALOG_RESOURCE_INVALID')
  }
  return value
}

function isResourceType(value: string): value is DownloadResourceType {
  return value === 'download' || value === 'external-entry'
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
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
