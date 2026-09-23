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
  githubRepository?: string, mirrorHosts?: readonly string[]): UpdateRelease {
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('UPDATE_MANIFEST_INVALID')
  const envelope = JSON.parse(body) as { payload: string; signature: string }
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('UPDATE_MANIFEST_INVALID')
  const payload = Buffer.from(envelope.payload, 'base64')
  if (!verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('UPDATE_SIGNATURE_INVALID')
  const release = JSON.parse(payload.toString('utf8')) as UpdateRelease
  if (typeof release.version !== 'string' || !/^\d+\.\d+\.\d+(?:-unified\.\d+)?$/.test(release.version) ||
      typeof release.notes !== 'string' || release.notes.length > 6000 ||
      !release.assets || typeof release.assets !== 'object') throw new Error('UPDATE_MANIFEST_INVALID')
  if (release.version !== installed && !newerVersion(release.version, installed) && !newerVersion(installed, release.version)) throw new Error('UPDATE_VERSION_INVALID')
  // 「清单没有更新可推」≠「检查失败」(IM-01 2026-09-20:线上清单停在 0.5.10 且无 darwin-x64,
  // Intel 客户装着 0.5.11+ 也在此被误判解析失败,永远报「暂时无法检查更新」)。清单不比已装新
  // (更旧或同版)就直接放行,调用方按 newerVersion 走既有「已是最新」;清单确有新版时,
  // 下面的平台资产检查照旧如实抛 UPDATE_PLATFORM_UNAVAILABLE。
  if (!newerVersion(release.version, installed)) return release
  const asset = release.assets[platform]
  if (!asset || typeof asset.url !== 'string' || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 2 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[a-f0-9]{64}$/.test(asset.asarSha256)) throw new Error('UPDATE_PLATFORM_UNAVAILABLE')
  const url = new URL(asset.url)
  if (url.origin !== origin.origin || !url.pathname.startsWith(`${origin.pathname.replace(/\/$/, '')}/updates/`) || url.username || url.password || url.hash ||
      !url.pathname.endsWith(platform.startsWith('darwin-') ? '.zip' : '.exe')) throw new Error('UPDATE_SOURCE_INVALID')
  if (asset.mirrors !== undefined) {
    if (!Array.isArray(asset.mirrors) || asset.mirrors.length === 0 || asset.mirrors.length > 2 ||
        new Set(asset.mirrors).size !== asset.mirrors.length ||
        asset.mirrors.some((mirror) => typeof mirror !== 'string' ||
          (!validGithubReleaseAsset(mirror, githubRepository, release.version, platform) &&
           !validMirrorAsset(mirror, mirrorHosts, origin, platform)))) {
      throw new Error('UPDATE_SOURCE_INVALID')
    }
  }
  return release
}

// 国内 CDN 镜像:GitHub 在国内实测直接超时连不上(2026-09-16 无代理真机实测),清单里挂着它
// 等于每个客户点更新都先白等一次超时。放行一条「可信镜像主机」通道 —— 主机名必须来自构建时
// 注入的白名单(⛔ 接受清单里任意主机:清单虽已签名,这一层是签名失效时的纵深防御),
// 且路径与文件名规则跟官网源完全一致,所以它只能指向同名的那个更新包,⛔ 指向别的文件。
// 最终防线仍是下载后的 sha256 校验。
function validMirrorAsset(value: string, hosts: readonly string[] | undefined, origin: URL, platform: string): boolean {
  if (!hosts || hosts.length === 0) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.startsWith(`${origin.pathname.replace(/\/$/, '')}/updates/`) &&
      url.pathname.endsWith(platform.startsWith('darwin-') ? '.zip' : '.exe')
  } catch { return false }
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
