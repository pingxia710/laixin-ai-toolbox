// Legacy read/write fixture only: all commands are supplied by each test, never the host.
export function createNetworksetupFixtureWrite(run) {
  return (ref, value) => {
    const commands = {
      'web-proxy': ['-setwebproxy', '-setwebproxystate'],
      'secure-web-proxy': ['-setsecurewebproxy', '-setsecurewebproxystate'],
      'socks-proxy': ['-setsocksfirewallproxy', '-setsocksfirewallproxystate'],
      'auto-proxy': ['-setautoproxyurl', '-setautoproxystate']
    }[ref.item]
    if (!commands) throw new Error('UNEXPECTED_FIXTURE_PROXY_ITEM')
    if (value && ref.item === 'auto-proxy' && value.url) run('networksetup', [commands[0], ref.service, value.url])
    if (value && ref.item !== 'auto-proxy' && (value.host || value.port)) {
      run('networksetup', [commands[0], ref.service, value.host, String(value.port)])
    }
    run('networksetup', [commands[1], ref.service, value?.enabled ? 'on' : 'off'])
  }
}
