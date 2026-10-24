import { constants, copyFileSync, cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { missingSidecarComponents } from '../../../app/main/tunnel/sidecar-path'
import { xrayExecutable } from '../../../sidecar/mac/local-bridge.mjs'

/** 共享服务逻辑的 Mac 模拟环境：真 JS 守护 + 显式注入的假适配器/回环连接器。
 * 不执行 Mac 系统设置辅助程序；其占位件只模拟存在，不能用于原生/打包验收。
 * 本机桥仍使用宿主平台真实 Xray；被杀后的恢复请求由 kernel-kill-recovery 独立验证。
 */
export function macServiceSidecar(root: string): string {
  // macOS /var 临时路径是别名；脚本入口比较 argv 与 import.meta.url，必须用同一真实路径。
  const sidecarDir = join(realpathSync(root), 'sidecar', 'mac')
  cpSync(fileURLToPath(new URL('../../../sidecar/mac', import.meta.url)), sidecarDir, { recursive: true, dereference: true })
  // 临时守护仍需原依赖（Windows 的进程身份查询使用 koffi）。
  symlinkSync(realpathSync(fileURLToPath(new URL('../../../node_modules', import.meta.url))), join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir')
  mkdirSync(join(sidecarDir, 'bin'), { recursive: true })
  mkdirSync(join(root, 'xray'), { recursive: true })
  const marker = 'TEST FIXTURE ONLY: native execution is forbidden\n'
  for (const name of ['proxy-helper', 'write-lock']) writeFileSync(join(sidecarDir, 'bin', name), marker)
  const executable = xrayExecutable()
  for (const name of [basename(executable), 'geoip.dat', 'geosite.dat']) {
    copyFileSync(join(dirname(executable), name), join(root, 'xray', name), constants.COPYFILE_FICLONE)
  }
  // Mac 服务组件闸只识别 xray 名称；Windows 的实际桥执行 xray.exe，保留原宿主二进制。
  if (basename(executable) !== 'xray') copyFileSync(executable, join(root, 'xray', 'xray'), constants.COPYFILE_FICLONE)
  // JS 组件漏准备时在入口直接失败，不能变成数十秒的无原因超时。
  expect(missingSidecarComponents('macos', sidecarDir)).toEqual([])
  return sidecarDir
}
