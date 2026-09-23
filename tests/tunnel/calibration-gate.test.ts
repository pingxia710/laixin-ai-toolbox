// 甲-1 返工:常驻校准落定闸门的四条契约。
// 生产接线原先内联在 actions/tunnel.ts 的闭包里(calibrationWaiters / calibrationDone),零覆盖 ——
// 验收线变异测试指出:calibrationWaiters.splice(0) → slice(0, 0)(等待者永不执行 =
// 安装版重开永远不接续)现有的测试拦不住。抽成 createCalibrationGate 后,四条各自钉死:
// 任何校准结果都不能让接续永远等下去,也 ⛔ 重复执行(校准跑两次,接续补做两次 = 叫醒两轮)。
import { describe, expect, it } from 'vitest'
import { createCalibrationGate } from '../../app/main/tunnel/calibration-gate'

describe('常驻校准落定闸门', () => {
  it('落定前登记的:落定后执行且只执行一次;校准跑两次只执行一次', () => {
    const gate = createCalibrationGate()
    let ran = 0
    gate.afterCalibration(() => { ran += 1 })
    expect(ran).toBe(0) // 没落定就执行 = 抢跑(双守护的根)
    gate.markCalibrated()
    // 等待者永不执行的变异(原 splice(0) → slice(0, 0)):这里永远 0,安装版重开永远不接续 → 红
    expect(ran).toBe(1)
    gate.markCalibrated() // 校准重跑/重复落定:⛔ 再补做一遍
    expect(ran).toBe(1)
  })

  it('落定后登记的:立即执行,⛔ 排进死队列', () => {
    const gate = createCalibrationGate()
    gate.markCalibrated()
    let ran = 0
    gate.afterCalibration(() => { ran += 1 })
    // 等待期的手动连接若在落定之后才挂上来(时序竞争):必须马上补做
    expect(ran).toBe(1)
  })

  it('一个补做抛错不挡其余', () => {
    const gate = createCalibrationGate()
    const ran: string[] = []
    gate.afterCalibration(() => { ran.push('a'); throw new Error('第一个接续补做失败') })
    gate.afterCalibration(() => { ran.push('b') })
    expect(() => gate.markCalibrated()).not.toThrow()
    expect(ran).toEqual(['a', 'b'])
  })

  it('补做执行期间再登记的:立即执行(先清队列再执行,⛔ 进死队列等下一次校准)', () => {
    const gate = createCalibrationGate()
    gate.markCalibrated()
    let late = 0
    gate.afterCalibration(() => gate.afterCalibration(() => { late += 1 }))
    expect(late).toBe(1)
  })
})
