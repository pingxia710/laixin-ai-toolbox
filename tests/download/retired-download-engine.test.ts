import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const appMain = join(__dirname, '../../app/main')

// RETIRE01:下载引擎从未接线生产(DL-03 已退役下载专项准入,产品边界=只提供网络通道)。
// 本钉子防止引擎文件或引擎动作注册悄悄回流;download.openExternal 是平台安装卡
// 「到官方下载页」的活入口,与 catalog/tunnel-runtime 一起保留。
const retiredEngineFiles = [
  'app/main/download/download-manager.ts',
  'app/main/download/electron-download-engine.ts',
  'app/main/download/mac-artifact.ts',
  'app/main/download/win-artifact.ts',
  'app/main/download/task-store.ts',
  'app/main/download/preinstall.ts',
  'app/main/download/runtime-compatibility.ts',
]

it('retired download engine files stay removed', () => {
  for (const file of retiredEngineFiles) expect(existsSync(join(__dirname, '../..', file)), file).toBe(false)
})

it('installation report keeps only the installation channel', () => {
  const source = readFileSync(join(appMain, 'account/installation-report.ts'), 'utf8')
  expect(source.includes('setInstallationReporter')).toBe(true)
  expect(source.includes('DownloadTaskSnapshot')).toBe(false)
  expect(source.includes('setDownloadReporter')).toBe(false)
})

it('production entrypoints never register engine-driven download actions', () => {
  for (const entry of ['gui.ts', 'index.ts']) {
    const source = readFileSync(join(appMain, entry), 'utf8')
    expect(source.includes('registerDownloadActions'), entry).toBe(false)
  }
})

it('download actions keep only the live external-entry catalog surface', () => {
  const source = readFileSync(join(appMain, 'actions/download.ts'), 'utf8')
  expect(source.includes("'download.openExternal'")).toBe(true)
  for (const action of ['download.latest', 'download.status', 'download.chooseLocal']) {
    expect(source.includes(`'${action}'`), action).toBe(false)
  }
  expect(source.includes('DownloadManager')).toBe(false)
})

it('account client no longer carries the engine-only download report channel', () => {
  for (const file of ['account/client.ts', 'actions/account.ts']) {
    const source = readFileSync(join(appMain, file), 'utf8')
    expect(source.includes('captureDownloadReport'), file).toBe(false)
    expect(source.includes('setDownloadReporter'), file).toBe(false)
  }
})

// RETIRE03:下载去戏收尾——目录不再携带下载引擎专用的 type:'download' 条目
//(openExternal 只消费 external-entry);发布测速门禁守三个正式平台;
//引擎时代的孤儿阶段文案与探针不得回流。
it('install catalog carries only external-entry resources', () => {
  const catalog = JSON.parse(readFileSync(join(__dirname, '../../resources/catalog.json'), 'utf8'))
  const downloadEntries = catalog.resources.filter((r: { type: string }) => r.type === 'download')
  expect(downloadEntries, `catalog 不得再含 download 型条目:${downloadEntries.map((r: { id: string }) => r.id).join(',')}`).toEqual([])
})

it('release speed gate covers all three shipped installers', () => {
  const speed = readFileSync(join(__dirname, '../../scripts/verify-download-speed.mjs'), 'utf8')
  expect(speed.includes('laixin-ai-toolbox-mac-x64.dmg')).toBe(true)
  expect(speed.includes('laixin-ai-toolbox-windows-x64.exe')).toBe(true)
  expect(speed.includes('laixin-ai-toolbox-mac-arm64.dmg')).toBe(true)
})

it('public source export includes the release speed gate consumed by this test', () => {
  const exporterPath = join(__dirname, '../../scripts/export-public-source.mjs')
  if (!existsSync(exporterPath)) return // 公开导出本身不携带私库导出器，测速脚本已由上一用例直接核对。
  const exporter = readFileSync(exporterPath, 'utf8')
  expect(exporter.includes("'verify-download-speed.mjs'"), '公开导出后不得因缺测速脚本使完整测试失败').toBe(true)
})

it('engine-era electron probe stays removed', () => {
  // installation-stages.ts 仍被 tools/account/service.ts 消费(安装上报阶段文案),不是孤儿。
  expect(existsSync(join(__dirname, '../../tests/electron/download-sources-probe.cjs')), 'download-sources-probe 探针指向已删引擎,不得回流').toBe(false)
})
