// D3(0.4.9 网络组):「回答到一半断掉」要落进 C8 故障记录,客服才看得到那次是什么情况。
// 守护把「通道中断时有几条连接正在回数据」累计写进 traffic.json;主进程只在它变大时补一条,
// 记的是网络码与条数 —— ⛔ 网址、主机名、报文与任何正文。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { loadTrustContext } from '../../app/main/tunnel/trust'
import { faultLine, sanitizeFaultRecord } from '../../app/shared/fault-log-types'
import { makeTempDir, removeTempDir } from './helpers'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(removeTempDir) })

function service() {
  const dataDir = makeTempDir('stream-fault-')
  dirs.push(dataDir)
  mkdirSync(dataDir, { recursive: true })
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const recordFault = vi.fn()
  const tunnel = new TunnelService({
    dataDir, sidecarDir, trust: loadTrustContext({}, {}), now: () => Date.now(),
    picker: async () => undefined, spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
    routesFile: join(sidecarDir, 'routes.default.json'), recordFault
  })
  const writeTraffic = (interruptedStreams: number, activeStreams = 0) => {
    writeFileSync(join(dataDir, 'traffic.json'), JSON.stringify({
      source: 'local-proxy-entry', uploadBytes: 10, downloadBytes: 20,
      uploadBytesPerSecond: 1, downloadBytesPerSecond: 2,
      activeStreams, interruptedStreams, updatedAt: Date.now()
    }))
  }
  return { tunnel, recordFault, writeTraffic }
}

describe('「回答到一半断掉」进故障记录（D3）', () => {
  it('累计值变大时补一条,数字对得上;没变就不再重复记', () => {
    const f = service()
    f.writeTraffic(0)
    f.tunnel.status() // 第一次只记住基线,⛔ 把历史累计当成刚发生的
    expect(f.recordFault).not.toHaveBeenCalled()

    f.writeTraffic(3)
    f.tunnel.status()
    expect(f.recordFault).toHaveBeenCalledTimes(1)
    // 条数走 C8 的模板 id + 参数;记的是「这次断了 3 条」⛔ 开机以来的累计
    expect(f.recordFault.mock.calls[0][0]).toEqual({ network: 'AI_DIAG_STREAM_INTERRUPTED', note: 'stream_interrupted', noteParams: ['3'] })

    f.tunnel.status(); f.tunnel.status()
    expect(f.recordFault).toHaveBeenCalledTimes(1) // 同一次中断 ⛔ 反复记

    f.writeTraffic(5)
    f.tunnel.status()
    expect(f.recordFault).toHaveBeenCalledTimes(2) // 又多了 2 条,再记一次
    expect(f.recordFault.mock.calls[1][0]).toMatchObject({ note: 'stream_interrupted', noteParams: ['2'] })
  })

  it('换一次连接后累计从 0 重数:跟着回落,⛔ 因此漏记或倒着记', () => {
    const f = service()
    f.writeTraffic(4)
    f.tunnel.status()
    f.writeTraffic(0) // 新守护进程,计数器重置
    f.tunnel.status()
    expect(f.recordFault).not.toHaveBeenCalled()

    f.writeTraffic(1)
    f.tunnel.status()
    expect(f.recordFault).toHaveBeenCalledTimes(1)
    // 回落后从新基线 0 起算,条数是 1 ⛔ 拿掉的 4 条再算一遍
    expect(f.recordFault.mock.calls[0][0]).toMatchObject({ noteParams: ['1'] })
  })

  it('记下的这条经得起 C8 的清洗:只剩网络码,⛔ 夹带任何自由文本', () => {
    const f = service()
    f.writeTraffic(0); f.tunnel.status()
    f.writeTraffic(2); f.tunnel.status()
    const fault = f.recordFault.mock.calls[0][0] as Record<string, unknown>
    const sanitized = sanitizeFaultRecord({ ...fault, at: new Date().toISOString(), version: '0.4.9' })
    expect(sanitized).toMatchObject({ network: 'AI_DIAG_STREAM_INTERRUPTED', note: 'stream_interrupted', noteParams: ['2'] })
    // C8 的说明字段是受控枚举(乙窗口 feat.4 定),条数只能当模板参数进来;
    // 一个字的自由文本都不带,渲染时才拼成人话。
    expect(Object.keys(sanitized ?? {}).sort()).toEqual(['at', 'network', 'note', 'noteParams', 'version'])
    expect(faultLine(sanitized!)).toContain('通道中断时打断了 2 条回答')
  })
})
