/**
 * Build signed-manifest asset entries for one update origin.
 * The caller owns signing and file hashing; this module only maps already
 * verified file metadata to URLs so canonical and legacy manifests cannot
 * accidentally share the wrong primary origin.
 */
export function buildReleaseAssets(files, { origin, mirrorOrigin, githubRepository, version }) {
  return Object.fromEntries(Object.entries(files).map(([platform, file]) => [platform, {
    url: new URL(`updates/${file.name}`, origin).href,
    mirrors: [
      ...(mirrorOrigin ? [new URL(`updates/${file.name}`, mirrorOrigin).href] : []),
      `https://github.com/${githubRepository}/releases/download/v${version}/${file.name}`
    ],
    size: file.size,
    sha256: file.sha256,
    asarSha256: file.asarSha256
  }]))
}

export function sameUpdatePath(left, right) {
  const leftUrl = new URL(left)
  const rightUrl = new URL(right)
  return leftUrl.protocol === rightUrl.protocol && leftUrl.pathname.replace(/\/$/, '') === rightUrl.pathname.replace(/\/$/, '')
}
