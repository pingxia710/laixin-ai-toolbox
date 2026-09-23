export type InstallPlatformId = 'codex' | 'claude-code' | 'hermes' | 'deepseek-harness' | 'zcode' | 'kimi-code'

export interface MacIntelCompatibility {
  readonly status: 'supported' | 'unsupported' | 'unknown'
  readonly message?: string
}

const unsupported: Partial<Record<InstallPlatformId, string>> = {
  codex: '这台是 Intel Mac。Codex 当前官方桌面应用只支持 Apple 芯片，无法在 Intel Mac 上安装该桌面应用；需要使用 Codex 时可选择官方命令行方案。来信 AI 工具箱及其中的 AI 网络功能仍可使用。',
  hermes: '这台是 Intel Mac。Hermes 当前官方 macOS 安装器只支持 Apple 芯片，无法在 Intel Mac 上安装。来信 AI 工具箱及其中的 AI 网络功能仍可使用。'
}

export function macIntelCompatibility(platform: InstallPlatformId): MacIntelCompatibility {
  const message = unsupported[platform]
  if (message) return { status: 'unsupported', message }
  if (platform === 'deepseek-harness') {
    return { status: 'unknown', message: '这台是 Intel Mac。DeepSeek Harness 官方尚未明确 Intel Mac 适配信息，请在下载前到官方页面确认。来信 AI 工具箱及其中的 AI 网络功能仍可使用。' }
  }
  return { status: 'supported' }
}

export function isIntelMac(platform: string, architecture: string | undefined): boolean {
  return platform === 'darwin' && architecture === 'x64'
}
