import type { TunnelStatusView } from '../../../preload/api/tunnel'
import { textNode } from './account-overview'

export interface TrafficSample { at: number; upload: number; download: number; uploadLabel: string; downloadLabel: string }
export type NetworkActivity =
  | { kind: 'loading'; samples: readonly TrafficSample[] }
  | { kind: 'unavailable'; samples: readonly TrafficSample[] }
  | { kind: 'ready'; status: TunnelStatusView; samples: readonly TrafficSample[] }

// The existing bridge returns a rounded, local proxy-entry summary. The graph uses
// that same precision; it is not account usage or a measurement of the whole device.
export function readTrafficSample(summary: string | undefined, at: number): TrafficSample | undefined {
  const match = /^上传 (\d+(?:\.\d+)?) (B|KB|MB)\/秒 · 下载 (\d+(?:\.\d+)?) (B|KB|MB)\/秒 · 累计 /.exec(summary ?? '')
  if (!match) return undefined
  const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2 }
  const upload = Number(match[1]) * units[match[2]]
  const download = Number(match[3]) * units[match[4]]
  if (!Number.isFinite(upload) || !Number.isFinite(download)) return undefined
  return { at, upload, download, uploadLabel: `${match[1]} ${match[2]}/s`, downloadLabel: `${match[3]} ${match[4]}/s` }
}

let activity: NetworkActivity = { kind: 'loading', samples: [] }
const listeners = new Set<(value: NetworkActivity) => void>()
let timer: ReturnType<typeof setTimeout> | undefined
let pending: Promise<void> | undefined
let pollVersion = 0

export function refreshNetworkActivity(): Promise<void> {
  if (pending) return pending
  const version = pollVersion
  pending = (async () => {
    try {
      const status = await window.toolbox.tunnel.status()
      if (version !== pollVersion) return
      const now = Date.now()
      const sample = status.state === '已连' ? readTrafficSample(status.traffic, now) : undefined
      const previous = activity.samples.at(-1)
      const history = previous && now - previous.at <= 6_000 ? activity.samples : []
      const samples = sample ? [...history.filter((point) => point.at > now - 60_000), sample].slice(-31) : []
      activity = { kind: 'ready', status, samples }
    } catch {
      if (version !== pollVersion) return
      activity = { kind: 'unavailable', samples: [] }
    }
    for (const listener of listeners) listener(activity)
  })().finally(() => { pending = undefined })
  return pending
}

export function observeNetworkActivity(listener: (value: NetworkActivity) => void): () => void {
  listeners.add(listener)
  listener(activity)
  if (listeners.size === 1) {
    const version = ++pollVersion
    const tick = async (): Promise<void> => {
      if (document.visibilityState !== 'hidden') await refreshNetworkActivity()
      if (listeners.size && version === pollVersion) timer = setTimeout(() => { void tick() }, 2_000)
    }
    void tick()
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) { pollVersion++; clearTimeout(timer); timer = undefined; activity = { kind: 'loading', samples: [] } }
  }
}

export function renderTrafficChart(samples: readonly TrafficSample[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 300 60')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('network-activity-chart')
  if (samples.length < 2) return svg
  const end = samples[samples.length - 1].at
  const ceiling = Math.max(1, ...samples.flatMap((sample) => [sample.upload, sample.download]))
  for (const direction of ['upload', 'download'] as const) {
    const points = samples.map((sample) => `${Math.max(0, 300 - (end - sample.at) / 200)},${54 - sample[direction] / ceiling * 48}`).join(' ')
    const line = document.createElementNS(ns, 'polyline')
    line.setAttribute('points', points)
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', direction === 'upload' ? 'var(--accent-strong)' : 'var(--positive)')
    line.setAttribute('stroke-width', '1.8')
    line.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.append(line)
  }
  return svg
}

export function renderTrafficMeter(element: HTMLElement, value: NetworkActivity): void {
  const sample = value.samples.at(-1)
  const heading = textNode('p', '实时速率 · 近 1 分钟', 'activity-label')
  const graph = document.createElement('div'); graph.className = 'activity-graph'
  graph.append(renderTrafficChart(value.samples))
  if (value.samples.length < 2) graph.append(textNode('span', sample ? '正在积累速率记录' : value.kind === 'loading' ? '正在读取' : value.kind === 'unavailable' ? '暂时无法读取' : value.status.state === '已连' ? '等待速率数据' : '连接后显示速率', 'activity-empty'))
  const rates = document.createElement('div'); rates.className = 'activity-rates'
  for (const [label, rate, direction] of [['↑ 上传', sample?.uploadLabel, 'upload'], ['↓ 下载', sample?.downloadLabel, 'download']] as const) {
    const item = textNode('span', label, `activity-${direction}`)
    item.append(textNode('strong', rate ?? '—'))
    rates.append(item)
  }
  element.replaceChildren(heading, graph, rates)
  element.append(textNode('p', '本机代理入口统计', 'activity-note'))
}
