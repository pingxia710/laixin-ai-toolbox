export const softwareIds = ['hermes', 'codex', 'claude'] as const

// 软件标识在支持表中按数据扩展；产品当前要展示的软件列表由 softwareIds 单点给出。
export type SoftwareId = string

export const platforms = ['macos', 'windows'] as const

export type Platform = (typeof platforms)[number]

export function isSoftwareId(value: unknown): value is SoftwareId {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value)
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && platforms.includes(value as Platform)
}
