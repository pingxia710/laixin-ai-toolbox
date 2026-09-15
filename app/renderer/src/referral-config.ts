// 「邀请有礼」与 AI 交流群入口的配置。入口是企业微信官方群活码；
// 客户端只读取固定的来信官网清单，不能被任意远程地址替换。
import wecomGroupQr from './assets/referral/wecom-group-qr.png'

export const groupQrManifestUrl = 'https://laixin.net.cn/AI-tools/group-entry/manifest.json'
const groupQrImagePath = '/AI-tools/group-entry/qr/'
const groupLiveCodeKind = 'wecom-group-live-code'

export interface WeComGroupConfig {
  /** 卡片眉题。 */
  readonly label: string
  /** 卡片主标题。 */
  readonly title: string
  readonly description: string
  readonly qrImageSrc?: string
  readonly joinUrl?: string
  /** true = 已接入真实群二维码，卡片直接显示图片。 */
  readonly ready: boolean
}

export type GroupQrResolution =
  | { readonly source: 'remote' | 'bundled'; readonly imageUrl: string }
  | { readonly source: 'unavailable' }

type GroupQrFetcher = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>

export const wecomGroupConfig: WeComGroupConfig = {
  label: 'AI 使用交流群',
  title: '诚邀加入 AI 沟通群',
  description: '进群可以交流使用问题，第一时间了解功能更新和福利活动。',
  qrImageSrc: wecomGroupQr,
  ready: true
}

export function bundledGroupQr(config: WeComGroupConfig = wecomGroupConfig): GroupQrResolution {
  if (config.ready && config.qrImageSrc) return { source: 'bundled', imageUrl: config.qrImageSrc }
  return { source: 'unavailable' }
}

function acceptedManifest(value: unknown): GroupQrResolution | null {
  if (!value || typeof value !== 'object') return null
  const manifest = value as Record<string, unknown>
  if (manifest.kind !== groupLiveCodeKind || typeof manifest.version !== 'string' || typeof manifest.imageUrl !== 'string') return null
  try {
    const expected = new URL(groupQrManifestUrl)
    const image = new URL(manifest.imageUrl)
    if (image.origin !== expected.origin || !image.pathname.startsWith(groupQrImagePath) || image.search || image.hash) return null
    return { source: 'remote', imageUrl: image.toString() }
  } catch {
    return null
  }
}

/** 读取官网群活码清单；网络或格式异常均退回已随包的官方群活码。 */
export async function resolveGroupQr(options: {
  readonly fetcher?: GroupQrFetcher
  readonly config?: WeComGroupConfig
} = {}): Promise<GroupQrResolution> {
  const fallback = bundledGroupQr(options.config)
  const fetcher = options.fetcher ?? globalThis.fetch
  if (!fetcher) return fallback
  try {
    const response = await fetcher(groupQrManifestUrl, { cache: 'no-store', credentials: 'omit' })
    if (!response.ok) return fallback
    return acceptedManifest(await response.json()) ?? fallback
  } catch {
    return fallback
  }
}

// 游客看到的视觉占位示例（⛔ 非真实数据，界面上必须带「本地预览」标注；
// 登录用户的邀请码与奖励一律读真实账号数据，不走这里）。
export const invitePreview = {
  code: 'PREVIEW-5GB',
  sampleRemaining: '4.00 GB'
} as const
