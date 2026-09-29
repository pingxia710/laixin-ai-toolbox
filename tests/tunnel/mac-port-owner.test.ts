import { describe, expect, it } from 'vitest'
import { identifyPortOwner, isLaixinDaemonCommand } from '../../sidecar/mac/port-owner.mjs'

const daemonCommand = 'node /Applications/来信AI工具箱.app/Contents/Resources/sidecar/mac/tunnel-daemon.mjs --data-dir /private/tmp/x'

describe('macOS 入口端口归属取证（N-55）', () => {
  it('只把随包 daemon 脚本认作来信实例，不按端口或任意进程名猜归属', () => {
    expect(isLaixinDaemonCommand(daemonCommand)).toBe(true)
    expect(isLaixinDaemonCommand('node /tmp/laixin-helper.mjs')).toBe(false)
    expect(isLaixinDaemonCommand('/Applications/Other.app/Contents/Resources/sidecar/mac/tunnel-daemon.mjs')).toBe(false)
  })

  it('真实 lsof/ps 取证链把第二份来信、外部 PID、多监听和查询失败分开', () => {
    const owner = (lsof: unknown, command: unknown = daemonCommand) => identifyPortOwner(18080, { exec: (file: string) => {
      if (file === 'lsof') {
        if (lsof instanceof Error) throw lsof
        return String(lsof)
      }
      if (file === 'ps') {
        if (command instanceof Error) throw command
        return String(command)
      }
      throw new Error('UNEXPECTED_COMMAND')
    } })
    expect(owner('p4242\ncnode\n')).toEqual({ kind: 'laixin', pid: 4242 })
    expect(owner('p5252\ncnode\n', '/Applications/Other.app/Contents/MacOS/Other')).toEqual({ kind: 'other', pid: 5252 })
    expect(owner('p1\ncnode\np2\ncnode\n')).toMatchObject({ kind: 'unknown', reason: 'multiple-listeners' })
    const none = Object.assign(new Error('none'), { status: 1, stdout: '' })
    expect(owner(none)).toEqual({ kind: 'none' })
    expect(owner(new Error('permission denied'))).toEqual({ kind: 'unknown' })
  })
})
