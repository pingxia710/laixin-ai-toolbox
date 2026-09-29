/**
 * 把 macOS 默认路由设备绑定到唯一活动网络服务。
 * 两次默认路由读取夹住服务映射，无法证明、映射冲突或切网一律不猜。
 */
export function resolveActiveNetworkPath(run) {
  try {
    const before = defaultRouteInterface(run('/sbin/route', ['-n', 'get', 'default']))
    if (before === undefined) return { status: 'unknown' }
    const services = parseNetworkServiceOrder(run('networksetup', ['-listnetworkserviceorder']))
    const after = defaultRouteInterface(run('/sbin/route', ['-n', 'get', 'default']))
    if (after === undefined) return { status: 'unknown' }
    if (before !== after) return { status: 'changed' }
    const matches = services.filter((candidate) => candidate.device === before)
    if (matches.length !== 1) return { status: 'unknown' }
    return { status: 'resolved', path: { device: before, service: matches[0].service } }
  } catch {
    return { status: 'unknown' }
  }
}

function defaultRouteInterface(output) {
  const devices = [...output.matchAll(/^\s*interface:\s*(\S+)\s*$/gm)].map((match) => match[1])
  const unique = [...new Set(devices)]
  return unique.length === 1 && /^[a-z0-9._-]+$/i.test(unique[0]) ? unique[0] : undefined
}

function parseNetworkServiceOrder(output) {
  const result = []
  let pending
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('An asterisk')) continue
    const combined = /^\((\d+|\*)\)\s+(.+?)\s+\(Hardware Port:.*,\s*Device:\s*([^)]*)\)\s*$/.exec(line)
    if (combined !== null) {
      if (combined[1] !== '*' && combined[2].trim() !== '' && combined[3].trim() !== '') {
        result.push({ service: combined[2].trim(), device: combined[3].trim() })
      }
      pending = undefined
      continue
    }
    const service = /^\((\d+|\*)\)\s+(.+)$/.exec(line)
    if (service !== null) {
      pending = { service: service[2].trim(), disabled: service[1] === '*' }
      continue
    }
    const hardware = /^\(Hardware Port:.*,\s*Device:\s*([^)]*)\)\s*$/.exec(line)
    if (hardware !== null && pending !== undefined) {
      const device = hardware[1].trim()
      if (!pending.disabled && pending.service !== '' && device !== '') result.push({ service: pending.service, device })
      pending = undefined
    }
  }
  return result
}
