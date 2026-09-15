export interface ConnectivityTarget {
  readonly id: 'domestic' | 'external'
  readonly url: string
}

// 发车当刻核准的唯一网络目标配置；探测实现不另写主机。
export const connectivityTargets: readonly ConnectivityTarget[] = [
  {
    id: 'domestic',
    url: 'https://connectivitycheck.platform.hicloud.com/generate_204'
  },
  {
    id: 'external',
    url: 'https://www.gstatic.com/generate_204'
  }
]

export const NETWORK_PROBE_TIMEOUT_MS = 5_000
