export type IconName = 'dashboard' | 'usage' | 'network' | 'sparkle' | 'receipt' | 'share' | 'account' | 'settings' | 'arrow' | 'check' | 'play' | 'pause' | 'edit' | 'eye' | 'download' | 'help' | 'power' | 'refresh' | 'upload' | 'warning' | 'clock' | 'computer' | 'lock' | 'gift' | 'github'

const paths: Record<IconName, string> = {
  dashboard: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',
  usage: 'M4 20V10m8 10V4m8 16v-7',
  network: 'M3 12a9 9 0 1 0 18 0A9 9 0 1 0 3 12Zm0 0h18M12 3c2.5 2.5 3.75 5.5 3.75 9S14.5 18.5 12 21c-2.5-2.5-3.75-5.5-3.75-9S9.5 5.5 12 3Z',
  sparkle: 'm12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Zm6 12 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z',
  receipt: 'M6 3h12v18l-3-1.7-3 1.7-3-1.7L6 21V3Zm3 5h6M9 12h6M9 16h4',
  share: 'M16 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.7 10.8l4.6-3M8.7 13.2l4.6 3',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0',
  gift: 'M20 12v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8M2 7h20v5H2V7Zm10 14V7m0 0H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7Zm0 0h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7Z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  check: 'm5 12 4.2 4.2L19 6.5',
  play: 'm8 5 11 7-11 7V5Z',
  pause: 'M9 5v14M15 5v14',
  edit: 'M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5-9 9-5 1 1-5 9-9Z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm7 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z',
  download: 'M12 3v12m-4-4 4 4 4-4M5 20h14',
  help: 'M9.5 9a2.7 2.7 0 1 1 4.7 1.8c-1.4.8-2.2 1.4-2.2 3.2m0 3.2h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  power: 'M12 3v8m4.9-5.2A8 8 0 1 1 7.1 5.8',
  refresh: 'M19 8a7 7 0 0 0-12-2L5 8m0-4v4h4m-4 8a7 7 0 0 0 12 2l2-2m0 4v-4h-4',
  upload: 'M12 21V9m-4 4 4-4 4 4M5 4h14',
  warning: 'M12 4 3.5 20h17L12 4Zm0 5v5m0 3h.01',
  clock: 'M12 7v5l3.5 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  computer: 'M4 5h16v11H4V5Zm5 15h6m-3-4v4',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3m-11 0h12v10H6V11Z',
  github: 'M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.3c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.9 2.9 1.4 3.6 1.1.1-.8.4-1.4.8-1.7-2.7-.3-5.6-1.4-5.6-6.1 0-1.4.5-2.5 1.3-3.4-.1-.3-.6-1.6.1-3.3 0 0 1.1-.3 3.5 1.3a12 12 0 0 1 6.4 0c2.5-1.6 3.5-1.3 3.5-1.3.7 1.8.3 3 .1 3.3.8.9 1.3 2 1.3 3.4 0 4.7-2.9 5.7-5.6 6.1.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z'
}

const fallback: Record<IconName, string> = {
  dashboard: '▦', usage: '▥', network: '○', sparkle: '✦', receipt: '□', share: '↗', account: '○', settings: '⚙',
  arrow: '→', check: '✓', play: '▷', pause: '‖', edit: '✎', eye: '◉', download: '↓', help: '?', power: '◉', refresh: '↻', upload: '↑',
  warning: '!', clock: '◷', computer: '▣', lock: '⌑', gift: '✿', github: '◉'
}

export function icon(name: IconName, className = ''): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.className = `icon${className === '' ? '' : ` ${className}`}`
  wrapper.setAttribute('aria-hidden', 'true')
  if (typeof document.createElementNS !== 'function') {
    wrapper.textContent = fallback[name]
    return wrapper
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  if (name === 'github') {
    svg.setAttribute('fill', 'currentColor')
    svg.setAttribute('stroke', 'none')
  } else {
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  wrapper.append(svg)
  return wrapper
}
