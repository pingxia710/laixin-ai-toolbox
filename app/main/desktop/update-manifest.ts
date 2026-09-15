import { verify } from 'node:crypto'

export interface UpdateAsset { url: string; mirrors?: string[]; size: number; sha256: string; asarSha256: string }
export interface UpdateRelease { version: string; notes: string; assets: Record<string, UpdateAsset> }

export function newerVersion(candidate: string, installed: string): boolean {
  const parse = (value: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-unified\.(\d+))?$/.exec(value)
    return match ? match.slice(1).map((part) => part === undefined ? Number.MAX_SAFE_INTEGER : Number(part)) : undefined
  }
  const next = parse(candidate), current = parse(installed)
  if (!next || !current || [...next, ...current].some((part) => !Number.isSafeInteger(part))) return false
  for (let index = 0; index < next.length; index++) if (next[index] !== current[index]) return next[index] > current[index]
  return false
}

export function readUpdateManifest(body: string, publicKey: string, origin: URL, platform: string, installed: string,
  githubRepository?: string): UpdateRelease {
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('UPDATE_MANIFEST_INVALID')
  const envelope = JSON.parse(body) as { payload: string; signature: string }
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('UPDATE_MANIFEST_INVALID')
  const payload = Buffer.from(envelope.payload, 'base64')
  if (!verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('UPDATE_SIGNATURE_INVALID')
  const release = JSON.parse(payload.toString('utf8')) as UpdateRelease
  if (typeof release.version !== 'string' || !/^\d+\.\d+\.\d+(?:-unified\.\d+)?$/.test(release.version) ||
      typeof release.notes !== 'string' || release.notes.length > 6000 ||
      !release.assets || typeof release.assets !== 'object') throw new Error('UPDATE_MANIFEST_INVALID')
  const asset = release.assets[platform]
  if (!asset || typeof asset.url !== 'string' || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 2 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[a-f0-9]{64}$/.test(asset.asarSha256)) throw new Error('UPDATE_PLATFORM_UNAVAILABLE')
  const url = new URL(asset.url)
  if (url.origin !== origin.origin || !url.pathname.startsWith(`${origin.pathname.replace(/\/$/, '')}/updates/`) || url.username || url.password || url.hash ||
      !url.pathname.endsWith(platform.startsWith('darwin-') ? '.zip' : '.exe')) throw new Error('UPDATE_SOURCE_INVALID')
  if (asset.mirrors !== undefined) {
    if (!Array.isArray(asset.mirrors) || asset.mirrors.length === 0 || asset.mirrors.length > 2 ||
        new Set(asset.mirrors).size !== asset.mirrors.length ||
        asset.mirrors.some((mirror) => typeof mirror !== 'string' || !validGithubReleaseAsset(mirror, githubRepository, release.version, platform))) {
      throw new Error('UPDATE_SOURCE_INVALID')
    }
  }
  if (release.version !== installed && !newerVersion(release.version, installed) && !newerVersion(installed, release.version)) throw new Error('UPDATE_VERSION_INVALID')
  return release
}

function validGithubReleaseAsset(value: string, repository: string | undefined, version: string, platform: string): boolean {
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return false
  try {
    const url = new URL(value)
    const [owner, name] = repository.split('/')
    const parts = url.pathname.split('/').filter(Boolean)
    const expectedExtension = platform.startsWith('darwin-') ? '.zip' : '.exe'
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.search && !url.hash &&
      parts.length === 6 && parts[0] === owner && parts[1] === name && parts[2] === 'releases' && parts[3] === 'download' &&
      parts[4] === `v${version}` && parts[5].endsWith(expectedExtension)
  } catch { return false }
}
