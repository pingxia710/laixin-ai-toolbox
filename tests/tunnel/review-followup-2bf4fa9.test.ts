// GPT-6 复核 2bf4fa9 的两条用例(原样收进仓库):
// ① 退出时恢复写失败、守护留在慢恢复期间客户重开工具箱:新守护先还旧账再连上;旧守护醒来必须交权,⛔ 再把新会话的设置还掉;
// ② mac 接管关掉 PAC 后,别的软件改了地址(仍关着):退出时那是他的设置,⛔ 覆盖回旧地址、更 ⛔ 重新打开旧 PAC。
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { pendingSettingEntries } from '../../sidecar/win/ledger.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { macDaemonLaunch } from '../../app/main/tunnel/platform/mac'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
const directory = () => { const root = makeTempDir('review-2bf4fa9-'); roots.push(root); return root }
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

it('退出后重开并已连接，旧守护的慢恢复不得还原新会话', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  let locked = false
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (locked) throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  let oldExit: number | undefined
  writeIntentFile(root, intent('old'))
  const old = createDaemon({ dataDir: root, runId: 'old', adapter, clock: clock(), parentAlive: () => true,
    onExit: code => { oldExit = code }, connectorFactory, bridgeFactory })
  await old.run()
  locked = true
  old.requestShutdown()
  await vi.advanceTimersByTimeAsync(70_000)
  expect(oldExit).toBeUndefined()
  locked = false
  // 与重开工具箱的自动接续一致：同一数据目录、新守护、先恢复旧账再连接。
  writeIntentFile(root, intent('new'))
  const fresh = createDaemon({ dataDir: root, runId: 'new', adapter, clock: clock(), parentAlive: () => true,
    onExit: () => {}, connectorFactory, bridgeFactory })
  await fresh.run()
  // 启动恢复梯子改为后台跑(甲-2):run() 不再等接续连接跑完,先驱动到落定再断言
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
  const view = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  expect(view()).toMatchObject({ state: 'connected', runId: 'new' })
  expect(base.read({ service: 'WinINET', item: 'ProxyEnable' })).toMatchObject({ data: '1' })
  await vi.advanceTimersByTimeAsync(29_000)
  const observed = { oldExit, state: view(), proxy: base.read({ service: 'WinINET', item: 'ProxyServer' }),
    enable: base.read({ service: 'WinINET', item: 'ProxyEnable' }), pending: pendingSettingEntries(root).length }
  fresh.requestShutdown()
  await vi.advanceTimersByTimeAsync(1)
  expect(observed.enable).toMatchObject({ data: '1' })
  expect(observed.proxy).toMatchObject({ data: '127.0.0.1:18080' })
  expect(observed.state).toMatchObject({ state: 'connected', runId: 'new' })
})

it('接管期间外部软件修改已关闭的 PAC 地址，退出不得重新启用旧 PAC', () => {
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
    const daemon=createDaemon({ dataDir:${JSON.stringify(root)},adapter:createAdapter(),
      clock:{now:Date.now,setInterval:()=>0,setTimeout:()=>0,clearTimer:()=>{}},parentAlive:()=>true,onExit:()=>{},
      connectorFactory:()=>({kind:'loopback-probe',start:async()=>{},stop:async()=>{},localProxyPort:()=>1,onLost:()=>{},verify:async()=>({exitIp:'203.0.113.1'})}),
      bridgeFactory:()=>({listen:async()=>{},close:async()=>{},isAlive:()=>true,onLost:()=>{}})})
    await daemon.run()
    const connected={pacEnabled,pacUrl}
    pacEnabled=false
    pacUrl='http://127.0.0.1:7891/b.pac'
    daemon.requestShutdown()
    await new Promise(resolve=>setTimeout(resolve,30))
    console.log(JSON.stringify({connected,restored:{pacEnabled,pacUrl},state:JSON.parse(readFileSync(${JSON.stringify(join(root, 'state.json'))},'utf8')).state}))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, ...macDaemonLaunch('/unused-review-path').env }
  })
  expect(result.status, result.stderr).toBe(0)
  const observed = JSON.parse(result.stdout)
  expect(observed.connected.pacEnabled).toBe(false)
  expect(observed.restored).toEqual({ pacEnabled: false, pacUrl: 'http://127.0.0.1:7891/b.pac' })
})
