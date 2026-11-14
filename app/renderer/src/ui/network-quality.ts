import type { QualityResult } from '../../../main/network-quality/controller'
import { button } from '../page-ui'

export interface QualityCardState {
  readonly running: boolean
  readonly canStart: boolean
  readonly isLaixin: boolean
  readonly result: QualityResult | undefined
}

export function parseQualityResult(raw: string): QualityResult {
  const value = JSON.parse(raw) as QualityResult
  if (!value || typeof value !== 'object') throw new Error('QUALITY_RESULT_INVALID')
  if (value.state === 'complete') {
    const m = value.measurement
    if (!m || !['shared', 'not-requested', 'not-shared'].includes(value.sharing) ||
        !Number.isSafeInteger(m.measuredAt) || m.measuredAt < 1 ||
        ![m.responseMs, m.responseSpreadMs, m.downloadMbps, m.uploadMbps].every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 100_000) ||
        ![m.downloadBytes, m.uploadBytes].every(item => Number.isSafeInteger(item) && item > 0 && item <= 2 * 1024 * 1024)) throw new Error('QUALITY_RESULT_INVALID')
    return value
  }
  if (!['unavailable', 'failed', 'cancelled'].includes(value.state) || typeof value.reason !== 'string' || value.reason.length > 40) throw new Error('QUALITY_RESULT_INVALID')
  return value
}

const errorText: Readonly<Record<string, string>> = {
  'path-unavailable': '暂时无法确认当前网络，请稍后重试或联系来信客服。',
  'path-changed': '检查期间网络发生变化，本次结果未保存，请重新检查。',
  'service-unavailable': '网络检查服务暂未就绪，请稍后重试。',
  timeout: '检查超时，请稍后重试。',
  cancelled: '已取消本次检查。',
  busy: '上一次检查还在结束，请稍候。'
}

export function qualityCard(state: QualityCardState, actions: { start(): void; cancel(): void }): HTMLElement {
  const section = document.createElement('section')
  section.className = 'network-quality'
  const header = document.createElement('div'); header.className = 'network-quality-header'
  const heading = document.createElement('div')
  heading.append(Object.assign(document.createElement('h3'), { textContent: '网络测速' }))
  const complete = !state.running && state.result?.state === 'complete' ? state.result : undefined
  heading.append(Object.assign(document.createElement('p'), { className: 'network-quality-caption',
    textContent: complete ? `上次测速 · ${new Date(complete.measurement.measuredAt).toLocaleString('zh-CN')}` : '了解当前网络表现' }))
  const controls = document.createElement('div'); controls.className = 'network-quality-controls'
  const run = button(state.running ? '测速中…' : complete ? '重新测速' : '开始测速', { disabled: state.running || !state.canStart, onClick: actions.start })
  run.dataset.networkAction = 'quality-start'
  controls.append(run)
  if (state.running) {
    const cancel = button('取消', { onClick: actions.cancel }); cancel.dataset.networkAction = 'quality-cancel'; controls.append(cancel)
  }
  header.append(heading, controls); section.append(header)

  const measurement = complete?.measurement
  const metrics = document.createElement('dl'); metrics.className = 'network-quality-metrics'; metrics.setAttribute('aria-live', 'polite')
  for (const [label, value, unit] of [
    ['网络响应', measurement ? String(measurement.responseMs) : '—', 'ms'],
    ['网络下载', measurement ? measurement.downloadMbps.toFixed(1) : '—', 'Mbps'],
    ['网络上传', measurement ? measurement.uploadMbps.toFixed(1) : '—', 'Mbps']
  ]) {
    const item = document.createElement('div')
    const number = document.createElement('dd')
    number.append(document.createTextNode(value + ' '), Object.assign(document.createElement('span'), { textContent: unit }))
    item.append(Object.assign(document.createElement('dt'), { textContent: label }), number)
    if (label === '网络响应' && measurement) item.append(Object.assign(document.createElement('small'), {
      className: 'network-quality-spread', textContent: `响应波动 ${String(measurement.responseSpreadMs)} ms`
    }))
    metrics.append(item)
  }
  section.append(metrics)

  const footer = document.createElement('div'); footer.className = 'network-quality-footer'
  const note = document.createElement('span')
  note.textContent = state.isLaixin ? '约 4 MiB · 计入套餐流量 · 结果用于优化网络' : '约 4 MiB' + (state.canStart ? ' · 结果仅在本机显示' : '')
  footer.append(note)
  if (state.isLaixin) {
    const details = document.createElement('details'); details.className = 'network-quality-info'
    details.append(Object.assign(document.createElement('summary'), { textContent: '测速说明' }), Object.assign(document.createElement('p'), {
      textContent: '测速结果和可识别的网络出口地区、运营商用于评估服务器，最长保留 30 天；测速记录不保存原始地址或使用内容。'
    }))
    footer.append(details)
  }
  section.append(footer)
  const live = document.createElement('p'); live.className = 'network-quality-status'; live.setAttribute('aria-live', 'polite')
  if (state.running) live.textContent = '正在测速，可能需要几十秒。'
  else if (state.result && state.result.state !== 'complete') live.textContent = errorText[state.result.reason] ?? '本次测速未完成，请稍后重试。'
  else if (complete?.sharing === 'not-shared') live.textContent = '测速结果未能上传。'
  else if (!state.canStart) live.textContent = '连接网络后即可测速。'
  section.append(live)
  return section
}
