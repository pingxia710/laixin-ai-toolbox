import type { DownloadResource } from './types'

export function runtimeDownloadArchitecture(platform: NodeJS.Platform, architecture: string): 'arm64' | 'x86_64' | undefined {
  if (architecture === 'arm64') return 'arm64'
  if (architecture === 'x64' && (platform === 'darwin' || platform === 'win32')) return 'x86_64'
  return undefined
}

export function canChooseLocalDownload(
  runtime: { readonly platform: NodeJS.Platform; readonly architecture: string },
  resource: DownloadResource | undefined
): boolean {
  if (!resource || resource.type !== 'download') return false
  const expectedPlatform = runtime.platform === 'darwin' ? 'macos' : runtime.platform === 'win32' ? 'windows' : undefined
  const expectedArchitecture = runtimeDownloadArchitecture(runtime.platform, runtime.architecture)
  return resource.platform === expectedPlatform && resource.architecture === expectedArchitecture
}
