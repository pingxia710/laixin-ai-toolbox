import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMacProxyAuthorization } from '../../app/main/tunnel/mac-proxy-authorization'

describe('macOS 代理授权边界', () => {
  it('取消授权只提示本地权限，下一次显式连接可以重新授权；并发点击只弹一次', async () => {
    const calls: string[] = []
    const run = (async (file: string) => {
      calls.push(file)
      if (file === '/usr/bin/osascript') throw { stderr: 'User canceled. (-128)' }
      return { stdout: '{"ok":false,"code":"TUNNEL_PROXY_AUTH_REQUIRED"}', stderr: '' }
    }) as unknown as NonNullable<Parameters<typeof createMacProxyAuthorization>[1]>
    const authorize = createMacProxyAuthorization('/fixture/sidecar', run)
    const [first, second] = await Promise.all([authorize(), authorize()])
    expect(first?.code).toBe('TUNNEL_PROXY_AUTH_REQUIRED')
    expect(second).toEqual(first)
    expect(calls.filter((file) => file === '/usr/bin/osascript')).toHaveLength(1)
    await authorize()
    expect(calls.filter((file) => file === '/usr/bin/osascript')).toHaveLength(2)
  })
  it('安装后必须再核对原生助手就绪，已授权时不反复弹窗；路径不拼进 AppleScript', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    let installed = false
    const run = (async (file: string, args: readonly string[]) => {
      calls.push({ file, args })
      if (file === '/usr/bin/osascript') installed = true
      return { stdout: JSON.stringify({ ok: installed, version: 3 }), stderr: '' }
    }) as unknown as NonNullable<Parameters<typeof createMacProxyAuthorization>[1]>
    const authorize = createMacProxyAuthorization('/fixture/space and \' quote', run)
    expect(await authorize()).toBeUndefined()
    expect(await authorize()).toBeUndefined()
    const prompts = calls.filter(({ file }) => file === '/usr/bin/osascript')
    expect(prompts).toHaveLength(1)
    expect(prompts[0].args[1]).not.toContain('/fixture/')
    expect(prompts[0].args[2]).toBe('/fixture/space and \' quote/bin/proxy-helper')
    expect(calls.at(-1)?.args).toEqual(['status'])
    if (process.platform === 'darwin') {
      const temporary = mkdtempSync(join(tmpdir(), 'laixin-auth-script-'))
      try {
        // Compile only: never runs the script or asks for a password in tests.
        execFileSync('/usr/bin/osacompile', ['-o', join(temporary, 'authorization.scpt')], { input: prompts[0].args[1] })
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
  })

  it('生产适配器写入与恢复都走受限 DTO，不再以普通用户执行 networksetup 写操作', () => {
    const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import cp from 'node:child_process'
      import {syncBuiltinESMExports} from 'node:module'
      const calls=[]
      cp.execFileSync=(file,args,options)=>{
        if (!file.endsWith('/bin/proxy-helper')) throw new Error('unexpected system write')
        calls.push(JSON.parse(options.input)); return JSON.stringify({ok:true,version:3})
      }
      syncBuiltinESMExports(); process.env.TOOLBOX_REAL_NETWORK_ADAPTER='1'
      const {createAdapter}=await import(${JSON.stringify(adapterUrl)})
      const adapter=createAdapter(); const ref={service:'Wi-Fi',item:'web-proxy'}
      adapter.write(ref,{enabled:true,host:'127.0.0.1',port:18080})
      adapter.write(ref,{enabled:false,host:'',port:0},{restoring:true})
      console.log(JSON.stringify(calls))
    `], { encoding: 'utf8', timeout: 5000 })
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout).map((call: { op: string }) => call.op)).toEqual(['write', 'restore'])
  })
  it('生产适配器预检缺少特权助手时给出可重试的授权提示，不伪装成线路故障', () => {
    const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import cp from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      cp.execFileSync = () => JSON.stringify({ok:false,code:'TUNNEL_PROXY_AUTH_REQUIRED'})
      syncBuiltinESMExports()
      process.env.TOOLBOX_REAL_NETWORK_ADAPTER='1'
      const {createAdapter}=await import(${JSON.stringify(adapterUrl)})
      try { createAdapter().preflight(); console.log('MISSED_AUTH') }
      catch(error) { console.log(error.code) }
    `], { encoding: 'utf8', timeout: 5000 })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout.trim()).toBe('TUNNEL_PROXY_AUTH_REQUIRED')
  })
  it('特殊5已安装的 v3 助手在应用升级后直接复用，不重新授权或安装', async () => {
    const calls: string[] = []
    const run = (async (file: string) => {
      calls.push(file)
      if (file === '/usr/bin/osascript') throw new Error('unexpected reinstallation')
      return { stdout: JSON.stringify({ ok: true, version: 3 }), stderr: '' }
    }) as unknown as NonNullable<Parameters<typeof createMacProxyAuthorization>[1]>
    expect(await createMacProxyAuthorization('/fixture/upgraded/sidecar', run)()).toBeUndefined()
    expect(calls).toEqual(['/fixture/upgraded/sidecar/bin/proxy-helper'])
  })
  it.each(['old-v1', 'old-v2', 'dead-listener'])('显式连接会修复 %s 助手，不把旧安装当成就绪', async (condition) => {
    let installed = false
    let prompts = 0
    const run = (async (file: string) => {
      if (file === '/usr/bin/osascript') { installed = true; prompts += 1 }
      if (!installed && condition === 'dead-listener') throw { code: 'ECONNREFUSED' }
      return { stdout: JSON.stringify({ ok: true, version: installed ? 3 : condition === 'old-v1' ? 1 : 2 }), stderr: '' }
    }) as unknown as NonNullable<Parameters<typeof createMacProxyAuthorization>[1]>
    expect(await createMacProxyAuthorization('/fixture/sidecar', run)()).toBeUndefined()
    expect(prompts).toBe(1)
  })
  it.each([
    ['timeout', '等待超时'], ['refused', '监听器不可用'], ['exit', '请求进程异常'], ['invalid', '响应格式异常'],
    ['ambiguous', '当前网络位置中存在多个同名网络服务']
  ])('生产 IPC 保留 %s 故障分类', (condition, message) => {
    const url = new URL('../../sidecar/mac/proxy-privilege.mjs', import.meta.url).href
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'
      cp.execFileSync=()=>{
        const condition=${JSON.stringify(condition)}
        if(condition==='timeout') throw Object.assign(new Error('timed out'),{code:'ETIMEDOUT'})
        if(condition==='exit') throw Object.assign(new Error('failed'),{status:74})
        return condition==='invalid'?'not-json':JSON.stringify({ok:false,code:'TUNNEL_PROXY_HELPER_FAILED',reason:condition==='ambiguous'?'SERVICE_AMBIGUOUS':'CONNECTION_REFUSED'})
      }
      syncBuiltinESMExports(); const {proxyRequest}=await import(${JSON.stringify(url)})
      try {proxyRequest({op:'status'}); console.log('MISSED_FAILURE')}
      catch(error){console.log(JSON.stringify({code:error.code,message:error.message}))}
    `], { encoding: 'utf8', timeout: 5000 })
    expect(child.status, child.stderr).toBe(0)
    const result = JSON.parse(child.stdout)
    expect(result.code).toBe('TUNNEL_PROXY_HELPER_FAILED')
    expect(result.message).toContain(message)
  })
})
