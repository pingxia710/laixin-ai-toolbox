/** Retains only a CONNECT destination in memory, never request headers, credentials or payload. */
export function createApiDestinationGate() {
  let allowed
  const connections = new Set()
  return {
    restrict(targets) {
      allowed = targets === undefined ? undefined : new Set(targets)
      if (allowed) for (const connection of connections) {
        if (connection.target !== undefined && !allowed.has(connection.target)) connection.close()
      }
    },
    track(close) {
      const connection = { target: undefined, close }
      connections.add(connection)
      let pending = Buffer.alloc(0), stage = 'greeting'
      const decide = target => { connection.target = target; pending = Buffer.alloc(0) }
      return {
        consume(chunk) {
          if (connection.target === undefined) {
            pending = Buffer.concat([pending, chunk]).subarray(0, 4096)
            if (stage === 'greeting' && pending[0] === 5) {
              if (pending.length >= 2 && pending.length >= 2 + pending[1]) {
                pending = pending.subarray(2 + pending[1]); stage = 'socks-connect'
              }
            } else if (stage === 'greeting') {
              const end = pending.indexOf('\r\n')
              if (end >= 0) {
                const match = /^CONNECT ([a-z0-9.-]+):([1-9][0-9]{0,4}) HTTP\/1\.[01]$/i.exec(pending.toString('latin1', 0, end))
                decide(match && Number(match[2]) <= 65535 ? `${match[1].toLowerCase()}:${Number(match[2])}` : '')
              } else if (pending.length === 4096) decide('')
            }
            if (stage === 'socks-connect' && pending.length >= 4) {
              if (pending[0] !== 5 || pending[1] !== 1 || pending[2] !== 0) decide('')
              else {
                const type = pending[3]
                const length = type === 1 ? 10 : type === 3 && pending.length >= 5 ? pending[4] + 7 : type === 4 ? 22 : 0
                if (length && pending.length >= length) {
                  const host = type === 1 ? [...pending.subarray(4, 8)].join('.')
                    : type === 3 ? pending.toString('latin1', 5, length - 2).toLowerCase() : ''
                  const port = pending.readUInt16BE(length - 2)
                  decide(/^[a-z0-9.-]+$/.test(host) && port > 0 ? `${host}:${port}` : '')
                } else if (![1, 3, 4].includes(type)) decide('')
              }
            }
          }
          return allowed === undefined || connection.target === undefined || allowed.has(connection.target)
        },
        forget() { connections.delete(connection); pending = Buffer.alloc(0) }
      }
    }
  }
}
