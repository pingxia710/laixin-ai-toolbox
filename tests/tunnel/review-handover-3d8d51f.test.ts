// GPT-6 复核 3d8d51f 的三条用例(原样收进仓库,崩溃兜底一条补了旧守护的 runId——生产里由守护入口带上):
// ① 只有新连接意图、新守护没起来 → 旧恢复者仍是恢复者,故障解除后照样还;
// ② 新守护已接手 → 旧守护自身崩溃的兜底也遵守同一恢复权规则,不碰新会话;
// ③ PAC 连续被外部开启并换址 → 账目原值与写入值一起更新,退出恢复最后一次完整外部值。
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDaemon, installCrashBailout } from '../../sidecar/win/daemon-core.mjs'
import { pendingSettingEntries } from '../../sidecar/win/ledger.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { macDaemonLaunch } from '../../app/main/tunnel/platform/mac'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
const directory = () => { const root = makeTempDir('review-3d8d51f-'); roots.push(root); return root }
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); roots.splice(0).forEach(removeTempDir) })
const intent = (token: string) => ({ desired: 'connected' as const, sessionToken: token, bridgePort: 18080,
  connector: { kind: 'loopback-probe' as const, host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
const connectorFactory = () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
  localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) })
const bridgeFactory = () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} })
const clock = () => ({ now: Date.now,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
  clearTimer: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout) })

async function oldRecovery() {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const box = { locked: false, exit: undefined as number | undefined }
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (box.locked) throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  writeIntentFile(root, intent('old'))
  const old = createDaemon({ dataDir: root, runId: 'old', adapter, clock: clock(), parentAlive: () => true,
    onExit: code => { box.exit = code }, connectorFactory, bridgeFactory })
  await old.run()
  box.locked = true
  old.requestShutdown()
  await vi.advanceTimersByTimeAsync(70_000)
  expect(box.exit).toBeUndefined()
  return { root, base, adapter, box, old }
}

it('只有新连接意图但新守护未启动，旧恢复者不能当作已交接并退出', async () => {
  const h = await oldRecovery()
  // 新主程序已写连接意图，但在 spawn 前退出；没有新守护接手。
  writeIntentFile(h.root, intent('new-start-not-completed'))
  h.box.locked = false
  await vi.advanceTimersByTimeAsync(40_000)
  const observed = { oldExit: h.box.exit, state: JSON.parse(readFileSync(join(h.root, 'state.json'), 'utf8')),
    proxy: h.base.read({ service: 'WinINET', item: 'ProxyServer' }), pending: pendingSettingEntries(h.root).length }
  expect(observed.proxy).toBeNull()
  expect(observed.pending).toBe(0)
})

it('写了新连接意图、新守护晚一步才启动:旧恢复者在它真正接手后才交权,交权后不碰新会话', async () => {
  const h = await oldRecovery()
  writeIntentFile(h.root, intent('late'))
  h.box.locked = false
  // 意图写了 15 秒新守护才起来(主程序慢):这期间旧守护仍是恢复者
  await vi.advanceTimersByTimeAsync(15_000)
  const fresh = createDaemon({ dataDir: h.root, runId: 'late', adapter: h.adapter, clock: clock(), parentAlive: () => true,
    onExit: () => {}, connectorFactory, bridgeFactory })
  await fresh.run()
  // 启动恢复梯子改为后台跑(甲-2):run() 不再等接续连接跑完,先驱动到落定再断言
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
  const view = () => JSON.parse(readFileSync(join(h.root, 'state.json'), 'utf8'))
  expect(view()).toMatchObject({ runId: 'late', state: 'connected' })
  // 旧守护下一轮(98 秒)醒来:状态文件已是新守护的 → 交权退出 0,新会话的设置/状态原样
  await vi.advanceTimersByTimeAsync(20_000)
  expect(h.box.exit).toBe(0)
  expect(h.base.read({ service: 'WinINET', item: 'ProxyServer' })).toMatchObject({ data: '127.0.0.1:18080' })
  expect(view()).toMatchObject({ runId: 'late', state: 'connected' })
  fresh.requestShutdown(); await vi.advanceTimersByTimeAsync(1)
  expect(pendingSettingEntries(h.root)).toEqual([])
})

it('新会话已接手时，旧守护自身的崩溃兜底不能恢复新会话的账目', async () => {
  const h = await oldRecovery()
  h.box.locked = false
  writeIntentFile(h.root, intent('new'))
  const fresh = createDaemon({ dataDir: h.root, runId: 'new', adapter: h.adapter, clock: clock(), parentAlive: () => true,
    onExit: () => {}, connectorFactory, bridgeFactory })
  await fresh.run()
  // 启动恢复梯子改为后台跑(甲-2):run() 不再等接续连接跑完,先驱动到落定再断言
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(JSON.parse(readFileSync(join(h.root, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
  let crashExit: number | undefined
  // 生产里兜底由守护入口安装并带上本进程的 runId(tunnel-daemon.mjs);两个守护只在测试里同处一个进程,所以这里显式给旧守护的身份
  const bailout = installCrashBailout({ dataDir: h.root, adapterOf: () => h.adapter, runId: 'old', exit: code => { crashExit = code } })
  let observed
  try {
    process.emit('uncaughtException', Error('injected old-daemon crash during handover'))
    observed = { crashExit, state: JSON.parse(readFileSync(join(h.root, 'state.json'), 'utf8')),
      proxy: h.base.read({ service: 'WinINET', item: 'ProxyServer' }), pending: pendingSettingEntries(h.root).length }
  } finally {
    bailout.dispose()
    fresh.requestShutdown()
    await vi.advanceTimersByTimeAsync(1)
  }
  expect(observed.proxy).toMatchObject({ data: '127.0.0.1:18080' })
  expect(observed.state).toMatchObject({ runId: 'new', state: 'connected' })
})

it('PAC 连续两次被外部软件开启并换地址，退出须恢复最后一次完整外部值', () => {
  const root = directory()
  writeIntentFile(root, intent('pac'))
  const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
  const daemonUrl = new URL('../../sidecar/mac/daemon-core.mjs', import.meta.url).href
  const script = `
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { readFileSync } from 'node:fs'
    let pacEnabled = true
    let pacUrl = 'http://127.0.0.1:7890/a.pac'
    const settings = Object.fromEntries(['webproxy','securewebproxy','socksfirewallproxy'].map(k=>[k,{enabled:false,host:'',port:0}]))
    cp.execFileSync = (command,args) => {
      if(command !== 'networksetup') throw Error('UNEXPECTED_COMMAND')
      const op = args[0]
      if(op === '-listallnetworkservices') return 'An asterisk (*) denotes...\\nWi-Fi\\n'
      if(op === '-getautoproxyurl') return 'URL: '+pacUrl+'\\nEnabled: '+(pacEnabled?'Yes':'No')+'\\n'
      if(op === '-setautoproxystate') { pacEnabled=args[2]==='on'; return '' }
      if(op === '-setautoproxyurl') { pacUrl=args[2]; pacEnabled=true; return '' }
      for(const [field,value] of Object.entries(settings)) {
        if(op === '-get'+field) return 'Enabled: '+(value.enabled?'Yes':'No')+'\\nServer: '+value.host+'\\nPort: '+value.port+'\\nAuthenticated Proxy Enabled: 0\\n'
        if(op === '-set'+field) { value.host=args[2]; value.port=Number(args[3]); return '' }
        if(op === '-set'+field+'state') { value.enabled=args[2]==='on'; return '' }
      }
      throw Error('UNEXPECTED_COMMAND '+op)
    }
    syncBuiltinESMExports()
    const {createAdapter}=await import(${JSON.stringify(adapterUrl)})
    const {createDaemon}=await import(${JSON.stringify(daemonUrl)})
    const root=${JSON.stringify(root)}
    const daemon=createDaemon({ dataDir:root,adapter:createAdapter(),
      clock:{now:Date.now,setInterval:()=>0,setTimeout:()=>0,clearTimer:()=>{}},parentAlive:()=>true,onExit:()=>{},
      connectorFactory:()=>({kind:'loopback-probe',start:async()=>{},stop:async()=>{},localProxyPort:()=>1,onLost:()=>{},verify:async()=>({exitIp:'203.0.113.1'})}),
      bridgeFactory:()=>({listen:async()=>{},close:async()=>{},isAlive:()=>true,onLost:()=>{}})})
    await daemon.run()
    const repairs=[]
    for(const url of ['http://127.0.0.1:7891/b.pac','http://127.0.0.1:7892/c.pac']) {
      pacEnabled=true; pacUrl=url
      daemon.notifyEvent('network-change')
      await new Promise(resolve=>setTimeout(resolve,10))
      repairs.push({pacEnabled,pacUrl})
    }
    const ledgerBefore=JSON.parse(readFileSync(root+'/ledger.json','utf8')).filter(e=>e.item==='auto-proxy')
    daemon.requestShutdown()
    await new Promise(resolve=>setTimeout(resolve,30))
    console.log(JSON.stringify({repairs,ledgerBefore,restored:{pacEnabled,pacUrl},state:JSON.parse(readFileSync(root+'/state.json','utf8')).state}))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, ...macDaemonLaunch('/unused-review-path').env }
  })
  expect(result.status, result.stderr).toBe(0)
  const observed = JSON.parse(result.stdout)
  // 2026-09-15 起「两次连续被改即止损」(创始人定):第一次改回 → PAC 被关掉;
  // 第二次又被改 → 停止自动写回,保留对方现状(PAC 仍开着)。⛔ 再每轮都关它。
  expect(observed.repairs[0].pacEnabled).toBe(false)
  expect(observed.repairs[1].pacEnabled).toBe(true)
  // 本条用例的原始意图不变:退出必须还给对方**最后**写的那个完整值。
  expect(observed.restored).toEqual({ pacEnabled: true, pacUrl: 'http://127.0.0.1:7892/c.pac' })
})
