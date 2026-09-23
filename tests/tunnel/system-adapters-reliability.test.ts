import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

// 先替换全部系统命令，再加载带守卫的真实适配器。未匹配命令立即失败，绝不落到宿主系统。
function probe(platform: 'mac' | 'win', body: string): Record<string, unknown> {
  const path = new URL(`../../sidecar/${platform}/${platform === 'mac' ? 'adapter-networksetup' : 'adapter-wininet'}.mjs`, import.meta.url).href
  const script = `
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    let execute = () => { throw new Error('UNEXPECTED_SYSTEM_COMMAND') }
    childProcess.execFileSync = (...args) => execute(...args)
    syncBuiltinESMExports()
    process.env.TOOLBOX_REAL_NETWORK_ADAPTER = '1'
    const { createAdapter } = await import(${JSON.stringify(path)})
    const adapter = createAdapter()
    const denied = () => { throw Object.assign(new Error('Access is denied'), { status: 1 }) }
    const rejected = (action) => { try { action(); return false } catch { return true } }
    ${body}
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 })
  if (child.status !== 0) throw new Error(child.stderr)
  return JSON.parse(child.stdout) as Record<string, unknown>
}

type MacProxy = { enabled: boolean; host: string; port: number }
const managedProxy: MacProxy = { enabled: true, host: '127.0.0.1', port: 18080 }
const emptyProxy: MacProxy = { enabled: false, host: '', port: 0 }
const macProxyKinds = [
  { item: 'web-proxy', read: '-getwebproxy', write: '-setwebproxy', state: '-setwebproxystate' },
  { item: 'secure-web-proxy', read: '-getsecurewebproxy', write: '-setsecurewebproxy', state: '-setsecurewebproxystate' },
  { item: 'socks-proxy', read: '-getsocksfirewallproxy', write: '-setsocksfirewallproxy', state: '-setsocksfirewallproxystate' }
] as const

function restoreMacProxy(
  original: MacProxy | null,
  current: MacProxy,
  status = 'applied',
  refuseFirstWrite = false,
  item = 'socks-proxy'
) {
  const kind = macProxyKinds.find((candidate) => candidate.item === item)
  if (kind === undefined) throw new Error(`未知 Mac 代理项:${item}`)
  return probe('mac', `
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { restoreLedger, unrestoredEntries } = await import(${JSON.stringify(new URL('../../sidecar/mac/restore.mjs', import.meta.url).href)})
    const { appendSettingEntry, markEntry } = await import(${JSON.stringify(new URL('../../sidecar/mac/ledger.mjs', import.meta.url).href)})
    const dir = mkdtempSync(join(tmpdir(), 'mac-restore-protocol-'))
    try {
      let proxy = ${JSON.stringify(current)}
      let refuseWrite = ${JSON.stringify(refuseFirstWrite)}
      const command = ${JSON.stringify(kind)}
      const writes = []
      execute = (file, args) => {
        if (file !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        if (args[0] === command.read) return 'Enabled: ' + (proxy.enabled ? 'Yes' : 'No') + '\\nServer: ' + proxy.host + '\\nPort: ' + proxy.port + '\\nAuthenticated Proxy Enabled: 0\\n'
        if (![command.write, command.state].includes(args[0])) throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        writes.push(args)
        if (refuseWrite) return denied()
        if (args[0] === command.write) { proxy = { enabled: true, host: args[2], port: Number(args[3]) }; return '' }
        proxy.enabled = args[2] === 'on'
        return ''
      }
      const entry = appendSettingEntry(dir, { service: 'Wi-Fi', item: ${JSON.stringify(item)}, originalValue: ${JSON.stringify(original)}, writtenValue: ${JSON.stringify(managedProxy)}, sessionToken: 'fixture', time: 1 })
      markEntry(dir, entry.id, { status: ${JSON.stringify(status)} })
      const first = restoreLedger(dir, adapter)
      refuseWrite = false
      const second = restoreLedger(dir, adapter)
      console.log(JSON.stringify({ proxy, writes, first, second, pending: unrestoredEntries(dir), strictEqual: adapter.valuesEqual(proxy, ${JSON.stringify(original)}) }))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  `)
}

describe('真实适配器的命令与读数协议（系统调用已封闭替换）', () => {
  // D5:mac 侧此前没有连接前的所有权判断,别的代理软件开着时会被直接顶掉,
  // 而且它的设置会被当成「原值」记进账本。判据与 Windows 的 WinINET 适配器一致。
  it('macOS 连接前不再凭「有代理」拒绝:只报出电脑上别的代理给守护判能不能复用;我们自己的地址与已关闭的不算(发布审查 R4)', () => {
    const script = (proxies: Record<string, { enabled: boolean; host: string; port: number }>) => `
      const services = ${JSON.stringify(Object.keys(proxies))}
      const proxies = ${JSON.stringify(proxies)}
      execute = (file, args) => {
        if (file !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes...\\n' + services.join('\\n') + '\\n'
        const proxy = proxies[args[1]]
        if (proxy === undefined) throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        return 'Enabled: ' + (proxy.enabled ? 'Yes' : 'No') + '\\nServer: ' + proxy.host + '\\nPort: ' + proxy.port + '\\nAuthenticated Proxy Enabled: 0\\n'
      }
      let conflict = null
      try { adapter.preflight({ host: '127.0.0.1', port: 18080 }) } catch (error) { conflict = { code: error.code, message: error.message } }
      console.log(JSON.stringify({ conflict, existing: adapter.existingProxy({ host: '127.0.0.1', port: 18080 }) ?? null }))
    `
    const clash = probe('mac', script({ 'Wi-Fi': { enabled: true, host: '127.0.0.1', port: 7890 } }))
    expect(clash.conflict).toBeNull()
    expect(clash.existing).toMatchObject({ kind: 'http', host: '127.0.0.1', port: 7890, source: 'Wi-Fi/web-proxy' })

    const ours = probe('mac', script({ 'Wi-Fi': { enabled: true, host: '127.0.0.1', port: 18080 } }))
    expect(ours.conflict).toBeNull()
    expect(ours.existing).toBeNull()

    const disabled = probe('mac', script({ 'Wi-Fi': { enabled: false, host: '127.0.0.1', port: 7890 } }))
    expect(disabled.existing).toBeNull()

    // 多张网卡:任何一张开着别的代理都报出来
    const second = probe('mac', script({
      'Wi-Fi': { enabled: false, host: '', port: 0 },
      '以太网': { enabled: true, host: '192.168.1.9', port: 8080 }
    }))
    expect(second.conflict).toBeNull()
    expect(second.existing).toMatchObject({ host: '192.168.1.9', port: 8080 })
  })

  // D5:网络服务消失(VPN 断开、蓝牙 PAN 关掉、USB 网卡拔掉)与「没权限」必须分开。
  it('macOS 读到「网络服务已不存在」时给出独立错误码,⛔ 与权限失败混为一谈', () => {
    const result = probe('mac', `
      execute = (file, args) => {
        if (args[1] === '已拔掉的网卡') return '** Error: The parameter list is invalid.\\n'
        if (args[1] === '旧VPN') { const error = new Error('exit 1'); error.stdout = '** Error: not a recognized network service'; throw error }
        return denied()
      }
      const codeOf = (service) => { try { adapter.read({ service, item: 'socks-proxy' }); return null } catch (error) { return error.code } }
      console.log(JSON.stringify({ absent: codeOf('已拔掉的网卡'), absentOnExit: codeOf('旧VPN'), denied: codeOf('Wi-Fi') }))
    `)
    expect(result).toEqual({
      absent: 'TUNNEL_SETTING_TARGET_ABSENT',
      absentOnExit: 'TUNNEL_SETTING_TARGET_ABSENT',
      denied: 'TUNNEL_SETTINGS_NOT_APPLIED'
    })
  })

  // 上线检查 §4-1:本机 macOS 26.6.2 对不存在的服务,适配器真正会调用的那几条读命令
  // 输出的是「Unable to find item in network database.」(exit 8),而不是原来认的两句;
  // 「not a recognized network service」只出现在适配器从不调用的 -getinfo。
  // 所以 0.4.9 之前「服务消失不要求恢复」那句在真机上一次都没走到过。
  it('macOS 真实文本「Unable to find item in network database」认作服务已不存在,⛔ 让客户钉在「原设置尚未恢复」', () => {
    const result = probe('mac', `
      execute = (file, args) => {
        // 回放 evidence/net-mac-networksetup-absent-service.txt 的真实输出与退出码
        if (args[1] === '已拔掉的网卡') { const error = new Error('Command failed'); error.status = 8; error.stdout = '** Error: Unable to find item in network database.\\n'; throw error }
        if (args[1] === '只在标准输出里') return '** Error: Unable to find item in network database.\\n'
        return denied()
      }
      const codeOf = (service) => { try { adapter.read({ service, item: 'socks-proxy' }); return null } catch (error) { return error.code } }
      console.log(JSON.stringify({ absent: codeOf('已拔掉的网卡'), absentOnStdout: codeOf('只在标准输出里'), denied: codeOf('Wi-Fi') }))
    `)
    expect(result).toEqual({
      absent: 'TUNNEL_SETTING_TARGET_ABSENT',
      absentOnStdout: 'TUNNEL_SETTING_TARGET_ABSENT',
      denied: 'TUNNEL_SETTINGS_NOT_APPLIED'
    })
  })

  // -getautoproxyurl 对不存在的服务说的是「The parameters were not valid.」——这句话含糊:
  // 命令本身写错了也是这句。凭它直接判「服务没了」会把真该还原的设置悄悄跳过,所以要再查一次服务清单。
  it('「参数不对」这种含糊说法必须复查服务清单:真没了才算消失,还在就仍按失败处理', () => {
    const result = probe('mac', `
      const make = (services) => (file, args) => {
        if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes that a network service is disabled.\\n' + services.join('\\n') + '\\n'
        const error = new Error('Command failed'); error.status = 4; error.stdout = '** Error: The parameters were not valid.\\n'; throw error
      }
      const codeOf = (service) => { try { adapter.read({ service, item: 'socks-proxy' }); return null } catch (error) { return error.code } }
      execute = make(['Wi-Fi'])
      const gone = codeOf('旧VPN')
      const stillThere = codeOf('Wi-Fi')
      execute = make(['Wi-Fi', '*已停用的网卡'])
      const disabledStillThere = codeOf('已停用的网卡')
      console.log(JSON.stringify({ gone, stillThere, disabledStillThere }))
    `)
    expect(result).toEqual({
      gone: 'TUNNEL_SETTING_TARGET_ABSENT',
      // 服务还在 → 这句「参数不对」是别的原因,⛔ 当成消失把该还原的设置跳过去
      stillThere: 'TUNNEL_SETTINGS_NOT_APPLIED',
      // 停用(带 *)的服务仍然存在,同样 ⛔ 当成消失
      disabledStillThere: 'TUNNEL_SETTINGS_NOT_APPLIED'
    })
  })

  // 上线检查 §4-5:Windows 侧 AutoConfigURL 非空即冲突,mac 此前根本不读 -getautoproxyurl。
  it('macOS PAC 开着也不拒绝:报成 pac 交守护按不可判定处理;留着地址没启用/没设的不算(发布审查 R4)', () => {
    const script = (pac: Record<string, { url: string; enabled: boolean }>) => `
      const services = ['Wi-Fi']
      const pac = ${JSON.stringify(pac)}
      execute = (file, args) => {
        if (file !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes...\\n' + services.join('\\n') + '\\n'
        if (args[0] === '-getautoproxyurl') {
          const value = pac[args[1]] ?? { url: '(null)', enabled: false }
          return 'URL: ' + value.url + '\\nEnabled: ' + (value.enabled ? 'Yes' : 'No') + '\\n'
        }
        return 'Enabled: No\\nServer: \\nPort: 0\\nAuthenticated Proxy Enabled: 0\\n'
      }
      let conflict = null
      try { adapter.preflight({ host: '127.0.0.1', port: 18080 }) } catch (error) { conflict = { code: error.code, message: error.message } }
      console.log(JSON.stringify({ conflict, existing: adapter.existingProxy({ host: '127.0.0.1', port: 18080 }) ?? null }))
    `
    const enabled = probe('mac', script({ 'Wi-Fi': { url: 'http://127.0.0.1:7898/route.pac', enabled: true } }))
    expect(enabled.conflict).toBeNull()
    expect(enabled.existing).toMatchObject({ kind: 'pac', url: 'http://127.0.0.1:7898/route.pac' })

    // 留着地址但没启用、以及压根没设,都不算别人在管——⛔ 把历史残留说成 PAC
    expect(probe('mac', script({ 'Wi-Fi': { url: 'http://127.0.0.1:7898/route.pac', enabled: false } })).existing).toBeNull()
    expect(probe('mac', script({ 'Wi-Fi': { url: '(null)', enabled: true } })).existing).toBeNull()
    expect(probe('mac', script({})).existing).toBeNull()
  })

  it('列完清单到读它之间网卡被拔掉:那张卡已不在,谈不上冲突,⛔ 让整次连接失败', () => {
    const result = probe('mac', `
      execute = (file, args) => {
        if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes...\\nWi-Fi\\n旧VPN\\n'
        if (args[1] === '旧VPN') { const error = new Error('Command failed'); error.status = 8; error.stdout = '** Error: Unable to find item in network database.\\n'; throw error }
        if (args[0] === '-getautoproxyurl') return 'URL: (null)\\nEnabled: No\\n'
        return 'Enabled: No\\nServer: \\nPort: 0\\nAuthenticated Proxy Enabled: 0\\n'
      }
      let conflict = null
      try { adapter.preflight({ host: '127.0.0.1', port: 18080 }) } catch (error) { conflict = { code: error.code, message: error.message } }
      console.log(JSON.stringify({ conflict }))
    `)
    expect(result.conflict).toBeNull()
  })

  it('Windows 读取权限失败与删除失败不会变成键不存在', () => {
    const result = probe('win', `
      execute = denied
      const refusedPreflight = rejected(() => adapter.preflight({ host: '127.0.0.1', port: 18080 }))
      const refusedRead = rejected(() => adapter.read({ service: 'WinINET', item: 'ProxyEnable' }))
      execute = (file, args) => {
        if (file === 'reg.exe' && args[0] === 'query') return '    ProxyEnable    REG_DWORD    0x1\\r\\n'
        return denied()
      }
      const normalized = adapter.read({ service: 'WinINET', item: 'ProxyEnable' })
      const refusedDelete = rejected(() => adapter.write({ service: 'WinINET', item: 'ProxyEnable' }, null))
      console.log(JSON.stringify({ refusedPreflight, refusedRead, normalized, refusedDelete }))
    `)
    expect(result).toEqual({ refusedPreflight: true, refusedRead: true, refusedDelete: true, normalized: { type: 'REG_DWORD', data: '1' } })
  })

  it('Windows 明确不存在可读为 null，通知走 WinINET，保留字符串原值空格', () => {
    const result = probe('win', `
      const operations = []
      execute = (file, args, options) => {
        if (file === 'reg.exe') return denied()
        if (file !== 'powershell.exe') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        const request = JSON.parse(options.input)
        operations.push(request.operation)
        if (request.operation === 'read') return JSON.stringify(request.item === 'ProxyServer' ? { type: 'REG_SZ', data: ' old.proxy:8080 ' } : null)
        if (request.operation === 'notify') return 'true'
        throw new Error('UNEXPECTED_SYSTEM_COMMAND')
      }
      const missing = adapter.read({ service: 'WinINET', item: 'ProxyEnable' })
      const original = adapter.read({ service: 'WinINET', item: 'ProxyServer' })
      adapter.broadcastSettingsChanged()
      console.log(JSON.stringify({ missing, original, operations }))
    `)
    expect(result).toEqual({ missing: null, original: { type: 'REG_SZ', data: ' old.proxy:8080 ' }, operations: ['read', 'read', 'notify'] })
  })

  // networksetup 自己的错误行只有「行首 ** Error: 」一种形状(本机 macOS 实测,见适配器注释);
  // 夹具从裸「Error: 」改为真实形状——裸前缀在真机上不存在,且正是旧判据误伤客户数据的口子。
  it('Mac 拒绝成功退出但报错的写入，以及无法解释的读取内容', () => {
    expect(probe('mac', `
      execute = () => '** Error: Authorization failed.'
      const refusedWrite = rejected(() => adapter.write({ service: 'Wi-Fi', item: 'socks-proxy' }, { enabled: true, host: '127.0.0.1', port: 18080 }))
      execute = () => 'unknown response'
      const refusedRead = rejected(() => adapter.read({ service: 'Wi-Fi', item: 'socks-proxy' }))
      console.log(JSON.stringify({ refusedWrite, refusedRead }))
    `)).toEqual({ refusedWrite: true, refusedRead: true })
  })

  // 候选甲-3(2026-09-16):-listallnetworkservices 逐字回显客户起的网卡名(真机实测),
  // 里面含独立英文词 error/failed/not authorized 是客户的正常数据,⛔ 当失败嗅探。
  // 旧判据在成功输出里嗅这几个词 → managedItems(daemon-core applySettings 入口)必抛
  // 「系统代理设置被拒绝」→ 非致命码无限重试,客户永远连不上(真机已复现该抛出)。
  it('macOS 网卡名含 error/failed/not authorized 词:列出、读值、写入全链路照常,⛔ 误判「被拒绝」', () => {
    const services = ['Wi-Fi', '公司 error 专线', 'backup failed 链路', 'not authorized 网卡']
    const result = probe('mac', `
      const services = ${JSON.stringify(services)}
      const kinds = ${JSON.stringify(macProxyKinds)}
      const settings = {}
      for (const service of services) for (const kind of kinds) settings[service + '/' + kind.item] = { enabled: false, host: '', port: 0 }
      execute = (file, args) => {
        if (file !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes that a network service is disabled.\\n' + services.join('\\n') + '\\n'
        if (args[0] === '-getautoproxyurl') return 'URL: (null)\\nEnabled: No\\n'
        if (args[0] === '-setautoproxystate' || args[0] === '-setautoproxyurl') return ''
        const kind = kinds.find((candidate) => [candidate.read, candidate.write, candidate.state].includes(args[0]))
        if (kind === undefined) throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        const key = args[1] + '/' + kind.item
        if (args[0] === kind.read) { const value = settings[key]; return 'Enabled: ' + (value.enabled ? 'Yes' : 'No') + '\\nServer: ' + value.host + '\\nPort: ' + value.port + '\\nAuthenticated Proxy Enabled: 0\\n' }
        if (args[0] === kind.write) { settings[key] = { enabled: true, host: args[2], port: Number(args[3]) }; return '' }
        settings[key] = { ...settings[key], enabled: args[2] === 'on' }
        return ''
      }
      const outcome = (fn) => { try { return { ok: fn() } } catch (error) { return { code: error?.code ?? null, message: error?.message ?? String(error) } } }
      const managed = outcome(() => adapter.managedItems(${JSON.stringify(managedProxy)}))
      const applied = Array.isArray(managed.ok)
        ? outcome(() => managed.ok.map(({ ref, value }) => { adapter.read(ref); adapter.write(ref, value); return adapter.read(ref) }))
        : null
      console.log(JSON.stringify({ managed, applied }))
    `)
    expect(result.managed).toEqual({ ok: services.flatMap((service) => [
      ...macProxyKinds.map(({ item }) => ({ ref: { service, item }, value: managedProxy })),
      { ref: { service, item: 'auto-proxy' }, value: { enabled: false, url: '' } }
    ]) })
    const pacOff = { enabled: false, url: '' }
    expect(result.applied).toEqual({ ok: services.flatMap(() => [managedProxy, managedProxy, managedProxy, pacOff]) })
  })

  // 候选甲-3 触发面之二:已有代理的 Server 主机名含独立 error 词,-get*proxy 逐字回显。
  // 旧判据把它当「被拒绝」:守护读不出已有代理、接管前的读原值也必抛。
  it('macOS 已有代理主机名含 error 词:如实读出交守护判复用,接管列项照常', () => {
    const result = probe('mac', `
      execute = (file, args) => {
        if (file !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes that a network service is disabled.\\nWi-Fi\\n'
        if (args[0] === '-getautoproxyurl') return 'URL: (null)\\nEnabled: No\\n'
        if (args[0] === '-getwebproxy') return 'Enabled: Yes\\nServer: proxy.error.corp.local\\nPort: 8080\\nAuthenticated Proxy Enabled: 0\\n'
        return 'Enabled: No\\nServer: \\nPort: 0\\nAuthenticated Proxy Enabled: 0\\n'
      }
      const outcome = (fn) => { try { return { ok: fn() } } catch (error) { return { code: error?.code ?? null } } }
      console.log(JSON.stringify({
        existing: outcome(() => adapter.existingProxy({ host: '127.0.0.1', port: 18080 }) ?? null),
        original: outcome(() => adapter.read({ service: 'Wi-Fi', item: 'web-proxy' })),
        managed: outcome(() => adapter.managedItems(${JSON.stringify(managedProxy)}).length)
      }))
    `)
    expect(result.existing).toEqual({ ok: { kind: 'http', host: 'proxy.error.corp.local', port: 8080, source: 'Wi-Fi/web-proxy' } })
    expect(result.original).toEqual({ ok: { enabled: true, host: 'proxy.error.corp.local', port: 8080 } })
    expect(result.managed).toEqual({ ok: 4 })
  })

  // 候选甲-3 触发面之三:PAC 地址含独立 error 词,-getautoproxyurl 逐字回显。
  // managedItems 对每个服务都读 PAC(记下原地址) → 旧判据必抛。
  it('macOS PAC 地址含 error 词:报成 pac 交守护处理,接管列项照常并记下原地址', () => {
    const result = probe('mac', `
      execute = (file, args) => {
        if (file !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes that a network service is disabled.\\nWi-Fi\\n'
        if (args[0] === '-getautoproxyurl') return 'URL: http://error.corp.local/x.pac\\nEnabled: Yes\\n'
        return 'Enabled: No\\nServer: \\nPort: 0\\nAuthenticated Proxy Enabled: 0\\n'
      }
      const outcome = (fn) => { try { return { ok: fn() } } catch (error) { return { code: error?.code ?? null } } }
      console.log(JSON.stringify({
        existing: outcome(() => adapter.existingProxy({ host: '127.0.0.1', port: 18080 }) ?? null),
        managed: outcome(() => adapter.managedItems(${JSON.stringify(managedProxy)}))
      }))
    `)
    expect(result.existing).toEqual({ ok: { kind: 'pac', url: 'http://error.corp.local/x.pac', source: 'Wi-Fi' } })
    expect(result.managed).toEqual({ ok: [
      ...macProxyKinds.map(({ item }) => ({ ref: { service: 'Wi-Fi', item }, value: managedProxy })),
      { ref: { service: 'Wi-Fi', item: 'auto-proxy' }, value: { enabled: false, url: 'http://error.corp.local/x.pac' } }
    ] })
  })

  it('Mac 将 HTTP、HTTPS、SOCKS 分别读取、写入并保留各自关闭时的原主机和端口', () => {
    const originals = {
      'Wi-Fi/web-proxy': { enabled: false, host: 'old-http.invalid', port: 8080 },
      'Wi-Fi/secure-web-proxy': { enabled: false, host: 'old-https.invalid', port: 8443 },
      'Wi-Fi/socks-proxy': { enabled: false, host: 'old-socks.invalid', port: 7890 },
      'Ethernet/web-proxy': { enabled: false, host: 'ethernet-http.invalid', port: 8081 },
      'Ethernet/secure-web-proxy': { enabled: false, host: 'ethernet-https.invalid', port: 8444 },
      'Ethernet/socks-proxy': { enabled: false, host: 'ethernet-socks.invalid', port: 7891 }
    }
    const result = probe('mac', `
      const kinds = ${JSON.stringify(macProxyKinds)}
      const settings = ${JSON.stringify(originals)}
      const writes = []
      const output = (value) => 'Enabled: ' + (value.enabled ? 'Yes' : 'No') + '\\nServer: ' + value.host + '\\nPort: ' + value.port + '\\nAuthenticated Proxy Enabled: 0\\n'
      execute = (file, args) => {
        if (file !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        if (args[0] === '-listallnetworkservices') return 'An asterisk denotes that a network service is disabled.\\nWi-Fi\\nEthernet\\n'
        // PAC 开关也是受管项(GPT-6 复核 2a19530 #3):这里原本没设 PAC
        if (args[0] === '-getautoproxyurl') return 'URL: (null)\\nEnabled: No\\n'
        if (args[0] === '-setautoproxystate') { writes.push(args); return '' }
        const kind = kinds.find((candidate) => [candidate.read, candidate.write, candidate.state].includes(args[0]))
        if (kind === undefined) throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        const key = args[1] + '/' + kind.item
        if (args[0] === kind.read) return output(settings[key])
        writes.push(args)
        if (args[0] === kind.write) {
          settings[key] = { enabled: true, host: args[2], port: Number(args[3]) }
          return ''
        }
        settings[key] = { ...settings[key], enabled: args[2] === 'on' }
        return ''
      }
      const managed = adapter.managedItems(${JSON.stringify(managedProxy)})
      const wifi = managed.filter(({ ref }) => ref.service === 'Wi-Fi')
      const previous = wifi.map(({ ref }) => ({ ref, value: adapter.read(ref) }))
      for (const { ref, value } of wifi) adapter.write(ref, value)
      const applied = wifi.map(({ ref }) => adapter.read(ref))
      for (const { ref, value } of previous) adapter.write(ref, value)
      const restored = wifi.map(({ ref }) => adapter.read(ref))
      console.log(JSON.stringify({ managed, applied, restored, writes }))
    `)

    const pacOff = { enabled: false, url: '' }
    expect(result.managed).toEqual([
      ...macProxyKinds.map(({ item }) => ({ ref: { service: 'Wi-Fi', item }, value: managedProxy })),
      { ref: { service: 'Wi-Fi', item: 'auto-proxy' }, value: pacOff },
      ...macProxyKinds.map(({ item }) => ({ ref: { service: 'Ethernet', item }, value: managedProxy })),
      { ref: { service: 'Ethernet', item: 'auto-proxy' }, value: pacOff }
    ])
    expect(result.applied).toEqual([managedProxy, managedProxy, managedProxy, pacOff])
    expect(result.restored).toEqual([
      originals['Wi-Fi/web-proxy'],
      originals['Wi-Fi/secure-web-proxy'],
      originals['Wi-Fi/socks-proxy'],
      pacOff
    ])
    expect(result.writes).toEqual([
      ['-setwebproxy', 'Wi-Fi', '127.0.0.1', '18080'],
      ['-setwebproxystate', 'Wi-Fi', 'on'],
      ['-setsecurewebproxy', 'Wi-Fi', '127.0.0.1', '18080'],
      ['-setsecurewebproxystate', 'Wi-Fi', 'on'],
      ['-setsocksfirewallproxy', 'Wi-Fi', '127.0.0.1', '18080'],
      ['-setsocksfirewallproxystate', 'Wi-Fi', 'on'],
      ['-setautoproxystate', 'Wi-Fi', 'off'],
      ['-setwebproxy', 'Wi-Fi', 'old-http.invalid', '8080'],
      ['-setwebproxystate', 'Wi-Fi', 'off'],
      ['-setsecurewebproxy', 'Wi-Fi', 'old-https.invalid', '8443'],
      ['-setsecurewebproxystate', 'Wi-Fi', 'off'],
      ['-setsocksfirewallproxy', 'Wi-Fi', 'old-socks.invalid', '7890'],
      ['-setsocksfirewallproxystate', 'Wi-Fi', 'off'],
      ['-setautoproxystate', 'Wi-Fi', 'off']
    ])
  })

  it('Mac 关闭的代理仍保存并恢复原主机、端口', () => {
    const result = probe('mac', `
      let proxy = { enabled: false, host: 'previous.invalid', port: 7890 }
      execute = (file, args) => {
        if (file !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        if (args[0] === '-getsocksfirewallproxy') return 'Enabled: ' + (proxy.enabled ? 'Yes' : 'No') + '\\nServer: ' + proxy.host + '\\nPort: ' + proxy.port + '\\nAuthenticated Proxy Enabled: 0\\n'
        if (args[0] === '-setsocksfirewallproxy') { proxy.host = args[2]; proxy.port = Number(args[3]); return '' }
        if (args[0] === '-setsocksfirewallproxystate') { proxy.enabled = args[2] === 'on'; return '' }
        throw new Error('UNEXPECTED_SYSTEM_COMMAND')
      }
      const ref = { service: 'Wi-Fi', item: 'socks-proxy' }
      const original = adapter.read(ref)
      adapter.write(ref, { enabled: true, host: '127.0.0.1', port: 18080 })
      adapter.write(ref, original)
      console.log(JSON.stringify({ original, restored: adapter.read(ref) }))
    `)
    expect(result.original).toEqual({ enabled: false, host: 'previous.invalid', port: 7890 })
    expect(result.restored).toEqual(result.original)
  })

  it.each(macProxyKinds)('Mac $item 单独入账后，退出、失败重试及第三方改动均按归属处理', (kind) => {
    const original = { enabled: false, host: `previous-${kind.item}.invalid`, port: 7000 + macProxyKinds.indexOf(kind) }
    const restored = restoreMacProxy(original, managedProxy, 'applied', false, kind.item)
    expect(restored.first).toMatchObject({ restored: [{ item: kind.item, status: 'restored' }], failed: [], keptModified: [] })
    expect(restored.pending).toEqual([])
    expect(restored.proxy).toEqual(original)

    const failedThenRetried = restoreMacProxy(emptyProxy, managedProxy, 'applied', true, kind.item)
    expect(failedThenRetried.first).toMatchObject({ restored: [], failed: [{ item: kind.item, status: 'restore-failed' }] })
    expect(failedThenRetried.second).toMatchObject({ restored: [{ item: kind.item, status: 'restored' }], failed: [] })
    expect(failedThenRetried.pending).toEqual([])

    const thirdParty = { enabled: true, host: `other-${kind.item}.invalid`, port: 7900 + macProxyKinds.indexOf(kind) }
    const kept = restoreMacProxy(emptyProxy, thirdParty, 'applied', false, kind.item)
    // 第三方改过的保留现值并结为 preserved 终态(与 Windows 同一语义):⛔ 再挡住下一次连接
    expect(kept.first).toMatchObject({ restored: [], failed: [], keptModified: [{ item: kind.item, status: 'preserved' }] })
    expect(kept.proxy).toEqual(thirdParty)
    expect(kept.pending).toEqual([])
  })

  it.each(macProxyKinds)('Mac $item 关闭时保留的主机即使端口为 0 也按原值恢复', (kind) => {
    const original = { enabled: false, host: `zero-port-${kind.item}.invalid`, port: 0 }
    const restored = restoreMacProxy(original, managedProxy, 'applied', false, kind.item)
    expect(restored.first).toMatchObject({ restored: [{ item: kind.item, status: 'restored' }], failed: [], keptModified: [] })
    expect(restored.proxy).toEqual(original)
    expect(restored.strictEqual).toBe(true)
    expect(restored.writes).toEqual([
      [kind.write, 'Wi-Fi', original.host, '0'],
      [kind.state, 'Wi-Fi', 'off']
    ])
  })

  it.each(macProxyKinds)('Mac $item 设置状态命令失败后，已写入的地址仍可由其账目恢复', (kind) => {
    const original = { enabled: false, host: `before-${kind.item}.invalid`, port: 8100 + macProxyKinds.indexOf(kind) }
    const result = probe('mac', `
      const { mkdtempSync, rmSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { restoreLedger } = await import(${JSON.stringify(new URL('../../sidecar/mac/restore.mjs', import.meta.url).href)})
      const { appendSettingEntry } = await import(${JSON.stringify(new URL('../../sidecar/mac/ledger.mjs', import.meta.url).href)})
      const dir = mkdtempSync(join(tmpdir(), 'mac-partial-write-'))
      try {
        let proxy = ${JSON.stringify(original)}
        let rejectState = true
        execute = (file, args) => {
          if (file !== 'networksetup') throw new Error('UNEXPECTED_SYSTEM_COMMAND')
          if (args[0] === ${JSON.stringify(kind.read)}) return 'Enabled: ' + (proxy.enabled ? 'Yes' : 'No') + '\\nServer: ' + proxy.host + '\\nPort: ' + proxy.port + '\\nAuthenticated Proxy Enabled: 0\\n'
          if (args[0] === ${JSON.stringify(kind.write)}) {
            // networksetup 的 set*proxy 命令本身会打开代理；状态命令失败时读数仍是我们的完整值。
            proxy = { enabled: true, host: args[2], port: Number(args[3]) }
            return ''
          }
          if (args[0] === ${JSON.stringify(kind.state)}) {
            if (rejectState) return '** Error: Authorization failed.'
            proxy.enabled = args[2] === 'on'
            return ''
          }
          throw new Error('UNEXPECTED_SYSTEM_COMMAND')
        }
        const ref = { service: 'Wi-Fi', item: ${JSON.stringify(kind.item)} }
        appendSettingEntry(dir, { ...ref, originalValue: ${JSON.stringify(original)}, writtenValue: ${JSON.stringify(managedProxy)}, sessionToken: 'fixture', time: 1 })
        const writeFailed = rejected(() => adapter.write(ref, ${JSON.stringify(managedProxy)}))
        rejectState = false
        const restored = restoreLedger(dir, adapter)
        console.log(JSON.stringify({ writeFailed, proxy, restored }))
      } finally { rmSync(dir, { recursive: true, force: true }) }
    `)
    expect(result.writeFailed).toBe(true)
    expect(result.restored).toMatchObject({ restored: [{ item: kind.item, status: 'restored' }], failed: [], keptModified: [] })
    expect(result.proxy).toEqual(original)
  })

  it('Mac 原代理为空时停用自己的代理即可完成恢复，严格比较不把不同值视为相等', () => {
    const result = restoreMacProxy(emptyProxy, managedProxy)
    expect(result.first).toMatchObject({ restored: [{ status: 'restored' }], failed: [], keptModified: [] })
    expect(result.pending).toEqual([])
    expect(result.proxy).toEqual({ ...managedProxy, enabled: false })
    expect(result.strictEqual).toBe(false)
    expect(result.writes).toEqual([['-setsocksfirewallproxystate', 'Wi-Fi', 'off']])
  })

  it.each(['restore-failed', 'kept-modified'])('Mac 旧 %s 账目仅残留自己的已关闭代理时可完成恢复', (status) => {
    expect(restoreMacProxy(emptyProxy, { ...managedProxy, enabled: false }, status)).toMatchObject({
      first: { restored: [{ status: 'restored' }], failed: [], keptModified: [] }, pending: [], writes: []
    })
  })

  it('Mac 首次关闭失败保留账目，再次恢复成功后不会永久阻止连接', () => {
    const result = restoreMacProxy(emptyProxy, managedProxy, 'applied', true)
    expect(result.first).toMatchObject({ restored: [], failed: [{ status: 'restore-failed' }] })
    expect(result.second).toMatchObject({ restored: [{ status: 'restored' }], failed: [] })
    expect(result.pending).toEqual([])
  })

  it.each([emptyProxy, null])('Mac 恢复空值或旧 null 账目时保留第三方的关闭设置（原值 %j）', (original) => {
    const current = { enabled: false, host: 'another-proxy.invalid', port: 7890 }
    expect(restoreMacProxy(original, current)).toMatchObject({
      proxy: current, writes: [], pending: [], first: { keptModified: [{ status: 'preserved' }] }, strictEqual: false
    })
    expect(restoreMacProxy(original, { ...managedProxy, enabled: false, port: 18081 })).toMatchObject({
      writes: [], pending: [], first: { keptModified: [{ status: 'preserved' }] }
    })
  })

  it('Mac 旧 null 账目兼容恢复自己的代理，原非空关闭设置仍需完整还原', () => {
    expect(restoreMacProxy(null, managedProxy)).toMatchObject({ pending: [], proxy: { ...managedProxy, enabled: false } })
    const original = { enabled: false, host: 'previous.invalid', port: 7890 }
    expect(restoreMacProxy(original, managedProxy)).toMatchObject({ pending: [], proxy: original, strictEqual: true })
    expect(restoreMacProxy(original, { ...managedProxy, enabled: false })).toMatchObject({ writes: [], pending: [], first: { keptModified: [{ status: 'preserved' }] } })
  })
})
