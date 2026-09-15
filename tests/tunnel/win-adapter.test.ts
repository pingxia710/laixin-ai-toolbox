// Windows 真实 WinINET 适配器:注册表只经 reg.exe,本机(开发/CI)⛔ 不触;
// 这里只测加载闸放行后的接口形态与纯函数 ProxyOverride 合并逻辑。
// 守卫的「未放行必须拒」在 adapter-guard.test.ts。
// 放行钥匙是进程级环境变量,⛔ 在测试进程里改(并发文件共享 env)⇒ 断言在子进程内完成。
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

const ADAPTER_URL = new URL('../../sidecar/win/adapter-wininet.mjs', import.meta.url).href

interface ProbeResult {
  members: Record<string, boolean>
  invalidItemRejected: boolean
  overrideEmpty: string
  overrideMerged: string
  overrideDedup: string
  managedItems: Array<{ item: string; value: unknown }>
}

function probe(): ProbeResult {
  const script = `
    process.env.TOOLBOX_REAL_NETWORK_ADAPTER = '1'
    const mod = await import(${JSON.stringify(ADAPTER_URL)})
    const adapter = mod.createAdapter()
    let invalidItemRejected = false
    try { adapter.read({ service: 'Others', item: 'ProxyEnable' }) } catch (error) {
      invalidItemRejected = /WININET_ITEM_INVALID/.test(error.message)
    }
    console.log(JSON.stringify({
      members: {
        preflight: typeof adapter.preflight === 'function',
        managedItems: typeof adapter.managedItems === 'function',
        read: typeof adapter.read === 'function',
        write: typeof adapter.write === 'function',
        broadcastSettingsChanged: typeof adapter.broadcastSettingsChanged === 'function'
      },
      invalidItemRejected,
      overrideEmpty: mod.mergeProxyOverride('   '),
      overrideMerged: mod.mergeProxyOverride('corpxy.example; internal.example'),
      overrideDedup: mod.mergeProxyOverride('localhost;CORPXY.example')
    }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000
  })
  if (result.status !== 0) {
    throw new Error(`探针子进程失败 rc=${String(result.status)}:${result.stderr}`)
  }
  return JSON.parse(result.stdout) as ProbeResult
}

// 审计 A4(2026-09-12 上线检查):读缺失键时 reg.exe 失败也被当瞬时错误重试 3 次,
// 每项白等 ≈0.4 秒;四项里 ProxyServer/AutoConfigURL 常常就是不存在。
interface RetryProbeResult {
  missing: { attempts: number; delays: number[]; value: unknown }
  transient: { attempts: number; delays: number[]; value: unknown }
  localized: { attempts: number; parentProbes: number; delays: number[]; value: unknown }
}

function retryProbe(): RetryProbeResult {
  const script = `
    process.env.TOOLBOX_REAL_NETWORK_ADAPTER = '1'
    const mod = await import(${JSON.stringify(ADAPTER_URL)})
    const attempts = { ProxyServer: 0, ProxyEnable: 0, ProxyOverride: 0 }
    let parentProbes = 0
    let phase = 'missing'
    const delays = { missing: [], transient: [], localized: [] }
    const failure = (stderr) => { const error = new Error('reg.exe failed'); error.status = 1; error.stderr = stderr; error.stdout = ''; return error }
    const adapter = mod.createAdapter({
      execFile: (command, args, options) => {
        if (command === 'powershell.exe') {
          const request = JSON.parse((options ?? {}).input ?? '{}')
          if (request.operation === 'read') return 'null'
          throw new Error('unexpected registry request')
        }
        if (command !== 'reg.exe' || args[0] !== 'query') throw new Error('unexpected command')
        if (args.length === 2) { parentProbes += 1; return 'HKEY_CURRENT_USER\\\\...\\\\Internet Settings' }
        const item = args[3]
        attempts[item] += 1
        // 缺失键:reg.exe 的标准英文报错;瞬时错误:拒绝访问;本地化:中文报错被编码打乱成乱码。
        if (item === 'ProxyServer') throw failure('ERROR: The system was unable to find the specified registry key or value.')
        if (item === 'ProxyEnable') throw failure('ERROR: Access is denied.')
        throw failure('ERROR: \\ufffd\\ufffd\\ufffd\\ufffd\\ufffd\\ufffd\\ufffd\\ufffd\\ufffd\\ufffd')
      },
      sleep: (ms) => { delays[phase].push(ms) }
    })
    const missingValue = adapter.read({ service: 'WinINET', item: 'ProxyServer' })
    phase = 'transient'
    const transientValue = adapter.read({ service: 'WinINET', item: 'ProxyEnable' })
    phase = 'localized'
    const localizedValue = adapter.read({ service: 'WinINET', item: 'ProxyOverride' })
    console.log(JSON.stringify({
      missing: { attempts: attempts.ProxyServer, delays: delays.missing, value: missingValue },
      transient: { attempts: attempts.ProxyEnable, delays: delays.transient, value: transientValue },
      localized: { attempts: attempts.ProxyOverride, parentProbes, delays: delays.localized, value: localizedValue }
    }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
  if (result.status !== 0) {
    throw new Error(`探针子进程失败 rc=${String(result.status)}:${result.stderr}`)
  }
  return JSON.parse(result.stdout) as RetryProbeResult
}

describe('WinINET 读缺失键不再空转重试(审计 A4)', () => {
  const result = retryProbe()

  it('reg.exe 明说键/值不存在 → 只读 1 次、零等待,直接回落 .NET 通道判 null', () => {
    expect(result.missing.attempts).toBe(1)
    expect(result.missing.delays).toEqual([])
    expect(result.missing.value).toBeNull()
  })

  it('拒绝访问等瞬时错误 → 仍重试 3 次、两次间隔 200ms', () => {
    expect(result.transient.attempts).toBe(3)
    expect(result.transient.delays).toEqual([200, 200])
  })

  it('报错文本被系统语言或编码打乱 → 探一次父键定性,仍不重试', () => {
    expect(result.localized.attempts).toBe(1)
    expect(result.localized.parentProbes).toBe(1)
    expect(result.localized.delays).toEqual([])
  })
})

describe('WinINET 适配器纯逻辑(放行闸内,子进程)', () => {
  const result = probe()

  it('放行后 createAdapter 具备守护所需完整接口;非 WinINET 项受控拒', () => {
    expect(result.members).toEqual({
      preflight: true,
      managedItems: true,
      read: true,
      write: true,
      broadcastSettingsChanged: true
    })
    expect(result.invalidItemRejected).toBe(true)
  })

  it('ProxyOverride 合并:空原有 → 只落本地回环豁免;客户原有条目逐字保留,大小写去重', () => {
    expect(result.overrideEmpty).toBe('<local>;localhost;127.*')
    expect(result.overrideMerged).toBe('corpxy.example;internal.example;<local>;localhost;127.*')
    expect(result.overrideDedup).toBe('localhost;CORPXY.example;<local>;127.*')
  })

})

describe('WinINET 写序与瞬时重试(收敛包2 件5,放行闸内,子进程注入)', () => {
  const result = behaviorProbe()

  it('managedItems 顺序:先 ProxyServer 后 ProxyEnable(窗口期 ⛔ 指向旧值);恢复按账本逆序自然反过来', () => {
    // 只有四项:第五项「自动检测设置」(WPAD)在这个夹具里读不到那个值,按设计**不纳入**——
    // 读不到 / 认不得格式 / 本来就关着,一律原样不动。⛔ 把它的缺席当成「没实现」。
    expect(result.managedItemsOrder).toEqual(['ProxyServer', 'ProxyEnable', 'ProxyOverride', 'AutoConfigURL'])
    expect(result.managedValues.proxyServer).toEqual({ type: 'REG_SZ', data: '127.0.0.1:18080' })
    expect(result.managedValues.proxyEnable).toEqual({ type: 'REG_DWORD', data: '1' })
  })

  it('reg.exe 瞬时失败:重试 3 次(间隔 200ms)后成功,⛔ 一次失败判死刑', () => {
    expect(result.transientWrite.attempts).toBe(3)
    expect(result.transientWrite.delays).toEqual([200, 200])
    expect(result.transientWrite.threw).toBe(false)
    // 读路径同样受瞬时重试保护:override 的 reg query 失败两次后走 .NET 通道,期间先重试。
    // 四次而不是两次:managedItems 现在还要读一次「自动检测设置」(WPAD),它在这里同样撞上瞬时失败、
    // 同样重试两次、最后读不到——**然后那一项就不纳入受管**,正是「读不到就原样不动」那条设计。
    expect(result.readDelays).toEqual([200, 200, 200, 200])
  })

  it('reg.exe 持续失败:3 次尝试后报告可重试错误，不臆断组织策略', () => {
    expect(result.persistentWrite.attempts).toBe(3)
    expect(result.persistentWrite.delays).toEqual([200, 200])
    expect(result.persistentWrite.code).toBe('系统设置暂不可达')
  })
})

interface BehaviorProbeResult {
  managedItemsOrder: string[]
  managedValues: Record<string, unknown>
  readDelays: number[]
  transientWrite: { attempts: number, delays: number[], threw: boolean }
  persistentWrite: { attempts: number, delays: number[], code?: string }
}

function behaviorProbe(): BehaviorProbeResult {
  const script = `
    process.env.TOOLBOX_REAL_NETWORK_ADAPTER = '1'
    const mod = await import(${JSON.stringify(ADAPTER_URL)})
    let regAttempts = 0
    let phase = 'read'
    const delaysByPhase = { read: [], transient: [], persistent: [] }
    const recorded = { transient: { attempts: 0, threw: false }, persistent: { attempts: 0, code: undefined } }
    const makeAdapter = () => mod.createAdapter({
      execFile: (command, args, options) => {
        if (command === 'powershell.exe') {
          // wininet-settings.ps1 通道:按 stdin 请求作答;读数一律走这条(PAC 不存在 → null)
          const request = JSON.parse((options ?? {}).input ?? '{}')
          if (request.operation === 'read') return JSON.stringify(request.item === 'ProxyOverride' ? { type: 'REG_SZ', data: 'corp.example' } : null)
          if (request.operation === 'policy') return 'false'
          if (request.operation === 'notify') return 'true'
          throw new Error('unexpected registry request')
        }
        if (command === 'reg.exe') {
          if (args[0] === 'add') {
            const isServerWrite = args[3] === 'ProxyServer'
            if (isServerWrite) { recorded.transient.attempts += 1 } else { recorded.persistent.attempts += 1 }
            const failHere = isServerWrite ? recorded.transient.attempts <= 2 : true
            if (failHere) throw new Error('Access is denied.')
            return ''
          }
          // query 一律失败:读数走 powershell 通道,失败重试行为由 delaysByPhase.read 断言
          throw new Error('reg.exe failed')
        }
        throw new Error('unexpected command')
      },
      sleep: (ms) => { delaysByPhase[phase].push(ms) }
    })
    const adapter = makeAdapter()
    const items = adapter.managedItems({ host: '127.0.0.1', port: 18080 })
    const order = items.map((managed) => managed.ref.item)
    const values = {}
    for (const managed of items) {
      if (managed.ref.item === 'ProxyServer') values.proxyServer = managed.value
      if (managed.ref.item === 'ProxyEnable') values.proxyEnable = managed.value
    }
    // 瞬时失败:前两次拒绝,第三次成功
    phase = 'transient'
    let transientThrew = false
    try { adapter.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:18080' }) } catch { transientThrew = true }
    recorded.transient.threw = transientThrew
    // 持续失败:ProxyEnable 永远拒
    phase = 'persistent'
    let persistentCode
    try { adapter.write({ service: 'WinINET', item: 'ProxyEnable' }, { type: 'REG_DWORD', data: '1' }) } catch (error) {
      persistentCode = error.code ?? error.message
    }
    console.log(JSON.stringify({
      managedItemsOrder: order,
      managedValues: values,
      readDelays: delaysByPhase.read,
      transientWrite: { attempts: recorded.transient.attempts, delays: delaysByPhase.transient, threw: recorded.transient.threw },
      persistentWrite: { attempts: recorded.persistent.attempts, delays: delaysByPhase.persistent, code: persistentCode }
    }))
  `
  const spawned = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000
  })
  if (spawned.status !== 0) {
    throw new Error(`探针子进程失败 rc=${String(spawned.status)}:${spawned.stderr}`)
  }
  return JSON.parse(spawned.stdout) as BehaviorProbeResult
}

// 创始人 09-13 真机断网链之一:每 30 秒三项字符串值都走 PowerShell(冷启动 + Add-Type),5 秒超时经常不够。
// 现在四项一律先走 reg.exe;只有非 ASCII / 解析不出才回落 .NET 通道;通知失败重试一次。
interface RegSzProbeResult {
  ascii: { value: unknown; powershellReads: number }
  nonAscii: { value: unknown; powershellReads: number }
  missing: { value: unknown; powershellReads: number }
  notify: { attempts: number; threw: boolean }
}

function regSzProbe(): RegSzProbeResult {
  const script = `
    process.env.TOOLBOX_REAL_NETWORK_ADAPTER = '1'
    const mod = await import(${JSON.stringify(ADAPTER_URL)})
    let mode = 'ascii'
    const powershellReads = { ascii: 0, nonAscii: 0, missing: 0 }
    let notifyAttempts = 0
    const adapter = mod.createAdapter({
      execFile: (command, args, options) => {
        if (command === 'reg.exe') {
          if (mode === 'missing') { const error = new Error('reg failed'); error.stderr = 'ERROR: The system was unable to find the specified registry key or value.'; throw error }
          const data = mode === 'ascii' ? '<local>;localhost;127.*' : 'corp\\u4ee3\\u7406.example'
          return 'HKEY_CURRENT_USER\\\\Software\\r\\n    ' + args[3] + '    REG_SZ    ' + data + '\\r\\n'
        }
        if (command === 'powershell.exe') {
          const request = JSON.parse((options ?? {}).input ?? '{}')
          if (request.operation === 'read') { powershellReads[mode] += 1; return JSON.stringify({ type: 'REG_SZ', data: 'from-dotnet' }) }
          if (request.operation === 'notify') { notifyAttempts += 1; if (notifyAttempts === 1) throw new Error('powershell slow'); return 'true' }
          throw new Error('unexpected ' + request.operation)
        }
        throw new Error('unexpected command')
      },
      sleep: () => undefined
    })
    const ascii = adapter.read({ service: 'WinINET', item: 'ProxyOverride' })
    mode = 'nonAscii'
    const nonAscii = adapter.read({ service: 'WinINET', item: 'AutoConfigURL' })
    mode = 'missing'
    const missing = adapter.read({ service: 'WinINET', item: 'ProxyServer' })
    let threw = false
    try { adapter.broadcastSettingsChanged() } catch { threw = true }
    console.log(JSON.stringify({
      ascii: { value: ascii, powershellReads: powershellReads.ascii },
      nonAscii: { value: nonAscii, powershellReads: powershellReads.nonAscii },
      missing: { value: missing, powershellReads: powershellReads.missing },
      notify: { attempts: notifyAttempts, threw }
    }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
  if (result.status !== 0) throw new Error(`探针子进程失败 rc=${String(result.status)}:${result.stderr}`)
  return JSON.parse(result.stdout) as RegSzProbeResult
}

describe('WinINET 字符串值直读 reg.exe(⛔ 每 30 秒起三个 PowerShell)', () => {
  const result = regSzProbe()

  it('纯 ASCII 的 REG_SZ 直接采信 reg.exe 读数,不起 PowerShell', () => {
    expect(result.ascii).toEqual({ value: { type: 'REG_SZ', data: '<local>;localhost;127.*' }, powershellReads: 0 })
  })

  it('含非 ASCII 的值回落 .NET 通道取精确值', () => {
    expect(result.nonAscii).toEqual({ value: { type: 'REG_SZ', data: 'from-dotnet' }, powershellReads: 1 })
  })

  it('值不存在直接判 null,⛔ 再起 PowerShell 确认', () => {
    expect(result.missing).toEqual({ value: null, powershellReads: 0 })
  })

  it('系统设置变更通知第一次失败会再试一次,第二次成功就不报错', () => {
    expect(result.notify).toEqual({ attempts: 2, threw: false })
  })
})

// 创始人 09-13「Clash 有的全部加上」:系统代理变更通知首选进程内原生调用(koffi → wininet.dll InternetSetOptionW),
// 组织策略探测先走 reg.exe;PowerShell 只剩回落。mac 上加载不到 wininet.dll,原生通道必须安静地回落。
interface NativeProbeResult {
  nativeOnMacUndefined: boolean
  nativeUsed: { native: number; powershell: number }
  nativeFallback: { native: number; powershell: number }
  policyAbsent: { managed: boolean; powershell: number }
  policyManagedByItem: { managed: boolean; powershell: number }
  policyMachineWide: { managed: boolean; powershell: number }
  policyTransient: { managed: boolean; powershell: number }
}

function nativeProbe(): NativeProbeResult {
  const script = `
    process.env.TOOLBOX_REAL_NETWORK_ADAPTER = '1'
    const mod = await import(${JSON.stringify(ADAPTER_URL)})
    const nativeOnMacUndefined = mod.loadNativeNotifier() === undefined
    const make = ({ nativeNotify, policy }) => {
      const counts = { native: 0, powershell: 0 }
      const adapter = mod.createAdapter({
        nativeNotify: nativeNotify === undefined ? undefined : () => { counts.native += 1; nativeNotify() },
        sleep: () => undefined,
        execFile: (command, args, options) => {
          if (command === 'powershell.exe') {
            counts.powershell += 1
            const request = JSON.parse((options ?? {}).input ?? '{}')
            if (request.operation === 'notify') return 'true'
            if (request.operation === 'policy') return 'true'
            return 'null'
          }
          if (command === 'reg.exe' && args[0] === 'query' && /Policies/.test(args[1])) {
            const mode = policy ?? 'absent'
            if (mode === 'absent') { const error = new Error('reg failed'); error.stderr = 'ERROR: The system was unable to find the specified registry key or value.'; throw error }
            if (mode === 'transient') { const error = new Error('reg failed'); error.stderr = 'ERROR: Access is denied.'; throw error }
            if (mode === 'item') return 'HKEY_CURRENT_USER\\\\Software\\\\Policies\\r\\n    ProxyServer    REG_SZ    corp:8080\\r\\n'
            if (mode === 'machine') return 'HKEY_LOCAL_MACHINE\\\\Software\\\\Policies\\r\\n    ProxySettingsPerUser    REG_DWORD    0x0\\r\\n'
          }
          throw new Error('unexpected command ' + command + ' ' + args.join(' '))
        }
      })
      return { adapter, counts }
    }
    const used = make({ nativeNotify: () => undefined }); used.adapter.broadcastSettingsChanged()
    const fallback = make({ nativeNotify: () => { throw new Error('native failed') } }); fallback.adapter.broadcastSettingsChanged()
    const policy = (mode) => { const p = make({ nativeNotify: undefined, policy: mode }); let managed = false; try { p.adapter.preflight({ host: '127.0.0.1', port: 18080 }) } catch (error) { managed = error.code === '受管理环境' }; return { managed, powershell: p.counts.powershell } }
    console.log(JSON.stringify({ nativeOnMacUndefined, nativeUsed: used.counts, nativeFallback: fallback.counts,
      policyAbsent: policy('absent'), policyManagedByItem: policy('item'), policyMachineWide: policy('machine'), policyTransient: policy('transient') }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
  if (result.status !== 0) throw new Error(`探针子进程失败 rc=${String(result.status)}:${result.stderr}`)
  return JSON.parse(result.stdout) as NativeProbeResult
}

describe('WinINET 原生通知与 reg.exe 策略探测', () => {
  const result = nativeProbe()

  it('mac 上加载不到 wininet.dll:原生通道安静回落,不抛', () => {
    expect(result.nativeOnMacUndefined).toBe(true)
  })

  it('原生通知可用时一次到位,不起 PowerShell;原生失败才回落 PowerShell', () => {
    expect(result.nativeUsed).toEqual({ native: 1, powershell: 0 })
    expect(result.nativeFallback).toEqual({ native: 1, powershell: 1 })
  })

  it('策略键不存在 → 未受管且不起 PowerShell;策略接管任一项或机器级代理 → 受管;reg.exe 瞬时错误才回落 PowerShell', () => {
    expect(result.policyAbsent).toEqual({ managed: false, powershell: 0 })
    expect(result.policyManagedByItem).toEqual({ managed: true, powershell: 0 })
    expect(result.policyMachineWide).toEqual({ managed: true, powershell: 0 })
    expect(result.policyTransient).toEqual({ managed: true, powershell: 1 })
  })
})
