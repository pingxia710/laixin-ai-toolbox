// Windows「Internet 选项 → 连接 → 局域网设置」里那个「自动检测设置」（WPAD）。
//
// 为什么要动它：它开着并且网络上真有 WPAD 服务器时，浏览器拿到的是 WPAD 派下来的 PAC，
// **优先于我们写的手工代理**——客户点了连接、我们也确实写进去了，他的流量却根本没走我们这条路。
// 这是场景清单 #21，公司网络常见。
//
// ⚠️ 两条独立的限定，都要如实记着，缺一条都会让后人高估这段代码的可信度：
//  1. **这个二进制结构没有微软文档**，位置是从第三方实现（fhluo/winproxy 的 settings 包把它定义成
//     Unknown/Version/Flags，flag 常量 Direct/Proxy/AutoProxyURL/AutoDetect）和若干 WPAD 排障资料反推的。
//  2. **没有在 Windows 真机上验证过**，与本包其余 Windows 行为同一限定。
//
// 所以这里的失败形态只允许有一种：**没做成**。认不出格式就原样不动，回落到今天的行为
// （手工代理照写，只是 WPAD 仍可能盖过它）——⛔ 猜着改，那会写坏客户的连接设置。
//
// 还原不走特殊路：整份 blob 作为一个受管项进账本（原值/写入值都是整份），
// 账本既有的「当前值 ≠ 我们写进去的值 ⇒ 保留现值」那条自然生效——公司 IT 中途推了新策略、
// 或客户自己改了设置，我们退出时 ⛔ 拿旧 blob 把他的改动抹掉。

/** flags 里的位。只用到 AUTO_DETECT，其余列出来是为了说明这 4 个字节还住着谁，⛔ 顺手清掉别人。 */
export const CONNECTION_FLAGS = Object.freeze({ direct: 1, proxy: 2, autoProxyUrl: 4, autoDetect: 8 })

/** blob 头部：version(4) + counter(4) + flags(4)，小端。 */
const HEADER_BYTES = 12
const FLAGS_OFFSET = 8
const COUNTER_OFFSET = 4

/**
 * 认不认得这份 blob。认不得就返回 undefined，调用方**原样不动**。
 * 校验故意保守：版本字节落在已知范围（0x3C / 0x46 那一带）、flags 高位为空。
 * 宁可误判成「认不得」（后果 = 这次没生效），也不能对一份没把握的结构下手。
 */
export function readConnectionSettings(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < HEADER_BYTES) return undefined
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const version = view.getUint32(0, true)
  const counter = view.getUint32(COUNTER_OFFSET, true)
  const flags = view.getUint32(FLAGS_OFFSET, true)
  if (version < 0x20 || version > 0xff) return undefined
  if (flags > 0xff) return undefined
  return { version, counter, flags }
}

/** 「自动检测设置」此刻开着吗。认不得格式返回 undefined（⛔ 当成 false：那会让调用方以为已经关好了）。 */
export function autoDetectEnabled(blob) {
  const parsed = readConnectionSettings(blob)
  if (parsed === undefined) return undefined
  return (parsed.flags & CONNECTION_FLAGS.autoDetect) !== 0
}

/**
 * 关掉「自动检测设置」，**其余字节一个不动**（后面还跟着代理地址、豁免列表、PAC 地址等，不归我们管）。
 * counter 跟着 +1：Windows 拿它判断设置有没有变过，不动它有组件不刷新。
 * 认不得格式、或本来就关着 → 返回 undefined，表示「无事可做」。
 */
export function withAutoDetectDisabled(blob) {
  const parsed = readConnectionSettings(blob)
  if (parsed === undefined) return undefined
  if ((parsed.flags & CONNECTION_FLAGS.autoDetect) === 0) return undefined
  const next = Uint8Array.prototype.slice.call(blob)
  const view = new DataView(next.buffer, next.byteOffset, next.byteLength)
  view.setUint32(FLAGS_OFFSET, parsed.flags & ~CONNECTION_FLAGS.autoDetect, true)
  view.setUint32(COUNTER_OFFSET, (parsed.counter + 1) >>> 0, true)
  return next
}

/** reg.exe 的 REG_BINARY 是一串十六进制。⛔ 大小写混用:账本要靠字符串相等判「有没有被别人改过」。 */
export function blobToHex(blob) {
  return Array.from(blob, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

export function hexToBlob(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined
  const blob = new Uint8Array(hex.length / 2)
  for (let i = 0; i < blob.length; i += 1) blob[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return blob
}

/**
 * 「自动检测设置」的所有权/还原判据(W2-1,真机 2026-09-14 定形):只看我们动过的那一位——
 * flags 的 autoDetect 位现在还是不是对方(账本写入值/原值)里的值。其余字节随 Windows 的
 * 连带规范化去(counter 跳变、DIRECT 位置位、整份 56→105 字节重写在真机上都会发生,
 * 整份字节比对会把我们自己的写入判成「外部改动」,客户的 WPAD 就被静默留在关)。
 * 两边都认得格式才给语义答案(undefined = 有一边认不得,调用方按字节比保守处理)。
 */
export function autoDetectBitsEqual(leftHex, rightHex) {
  const left = readConnectionSettings(hexToBlob(leftHex))
  const right = readConnectionSettings(hexToBlob(rightHex))
  if (left === undefined || right === undefined) return undefined
  return (left.flags & CONNECTION_FLAGS.autoDetect) === (right.flags & CONNECTION_FLAGS.autoDetect)
}

/**
 * 「自动检测设置」这一项要不要纳入受管。**生产适配器与测试夹具共用这一份**——
 * ⛔ 各写一份:写下那一刻两边一样,等生产改了夹具没改,用例就从守规则变成守墓。
 *
 * 三种情况一律返回 undefined（= 原样不动，回落到今天的行为）：
 *  · 读不到那份设置（没有这个值 / 类型不对）
 *  · 认不得这份二进制的格式（结构没有微软文档，没把握就不动）
 *  · 它本来就关着（⛔ 无谓地写一次、无谓地记一笔账）
 */
export function autoDetectManagedItem(current, { service, item }) {
  if (current === null || current === undefined || current.type !== 'REG_BINARY') return undefined
  const blob = hexToBlob(current.data)
  if (blob === undefined) return undefined
  const next = withAutoDetectDisabled(blob)
  if (next === undefined) return undefined
  return { ref: { service, item }, value: { type: 'REG_BINARY', data: blobToHex(next) } }
}
