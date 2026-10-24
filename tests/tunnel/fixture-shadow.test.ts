// 夹具里的「影子实现」会分头老化：写下那一刻两边一模一样，所以谁都不觉得有问题；
// 等生产改了、夹具没跟，用例就从守规则变成了守墓——改生产代码，用例照样绿。
//
// 今天在 fake-wininet-adapter.mjs 里已经逮到两处（端口正则、managedItems 的 override 合并），
// 都是抽成共用纯函数解决的。但 `managedItems` 「该管哪些项」这一维仍然是两边各写一份：
// 生产适配器带加载闸（真实系统适配器的放行钥匙，⛔ 在这里写出它的名字：adapter-guard 扫文本，
// 连注释一起算，写了就等于把这个文件加进那道闸的白名单），在这台机器上根本 import 不进来，
// 所以没法拿同一个输入跑两遍去比。能比的是**两边各自声称要管哪些项**——
// 这正是影子分头老化时最先分叉的那一维（生产新增一项受管设置、夹具没跟）。
//
// 这条的意义不在它查出了什么，在于**它不依赖谁记得**：docs 里的判据要有人读到并想起来才生效，
// 这条在每次跑用例时都生效。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PRODUCTION = join(__dirname, '..', '..', 'sidecar', 'win', 'adapter-wininet.mjs')
const FIXTURE = join(__dirname, 'fixtures', 'fake-wininet-adapter.mjs')

/** 取出 managedItems 函数体（到 `read,` 那一行为止——两份文件都是紧跟着返回 read/write 的）。 */
function managedItemsBody(path: string): string {
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf('managedItems(proxy)')
  expect(start, `${path} 里找不到 managedItems`).toBeGreaterThan(-1)
  const end = source.indexOf('\n    read,', start)
  expect(end, `${path} 的 managedItems 结尾认不出来`).toBeGreaterThan(start)
  return source.slice(start, end)
}

/** 这一份 managedItems 声称要管哪些注册表项。CONNECTION_ITEM 是两边同名的常量，归一成字面量。 */
function declaredItems(path: string): string[] {
  const body = managedItemsBody(path)
  const names = new Set<string>()
  for (const [, quoted] of body.matchAll(/item:\s*'([^']+)'/g)) names.add(quoted)
  if (/item:\s*CONNECTION_ITEM/.test(body)) names.add('DefaultConnectionSettings')
  // WPAD 那一项由共用纯函数产出（生产包了一层本地 autoDetectItem()，夹具直接调共用那个），
  // 函数体里看不到 item: 字面量，按调用点算数。
  if (/autoDetect\w*\(/.test(body)) names.add('DefaultConnectionSettings')
  return [...names].sort()
}

describe('假 WinINET 适配器 ⛔ 和生产分头老化', () => {
  it('两边声称要管的注册表项集合一致', () => {
    const production = declaredItems(PRODUCTION)
    const fixture = declaredItems(FIXTURE)
    // 正向证据：确实解析出了东西，⛔ 两边都空着也算「一致」
    expect(production.length).toBeGreaterThanOrEqual(4)
    expect(fixture).toEqual(production)
  })

  it('两边都先写 ProxyServer 再写 ProxyEnable（反过来会让客户流量在窗口期走丢）', () => {
    // 顺序在这里有真语义：Enable=1 先落时，系统代理短暂指向旧值。
    // 账本按逆序恢复，所以顺序错了连还原都跟着错。
    for (const path of [PRODUCTION, FIXTURE]) {
      const body = managedItemsBody(path)
      const server = body.indexOf("item: 'ProxyServer'")
      const enable = body.indexOf("item: 'ProxyEnable'")
      expect(server, `${path}: 找不到 ProxyServer`).toBeGreaterThan(-1)
      expect(enable, `${path}: 找不到 ProxyEnable`).toBeGreaterThan(-1)
      expect(server, `${path}: ProxyServer 必须排在 ProxyEnable 前面`).toBeLessThan(enable)
    }
  })

  it('WPAD 那一项两边都从共用模块 import，⛔ 各写一份', () => {
    // ⛔ 只断言「文件里出现过这个名字」——在本地补一个同名函数就能骗过去，
    // 而那正是「夹具自己复刻一份」的样子。要断言的是它**从共用模块 import 进来**。
    for (const path of [PRODUCTION, FIXTURE]) {
      expect(readFileSync(path, 'utf8'), `${path} 应当从 connection-settings.mjs import autoDetectManagedItem`)
        .toMatch(/import\s*\{[^}]*\bautoDetectManagedItem\b[^}]*\}\s*from\s*'[^']*connection-settings\.mjs'/)
    }
  })
})
