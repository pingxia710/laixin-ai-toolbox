// 「系统设置里那个代理，是不是我们自己的」——判据是**查我们用过哪些口**，⛔ 靠端口长什么样猜。
//
// 原判据是正则 /^18[0-9]80$/。入口候选口（18080→18180→…→18480）被占完时守护会退回系统随机分配，
// 那个口不长那样，于是我们自己上次留下的代理会被认成「客户的第三方代理」：接管时把它当作客户的原值
// 记进账本，客户退出时我们再"忠实地"把他还原成一个指向死端口的代理。
//
// **判据错了，不止是这一次判错——它会把错的判断写进账本，变成后面每一步的前提**，而后面每一步都会
// 「正确地」执行一个错误的前提，看起来都没毛病。账本是还原、交接、卸载兜底共同的事实来源。
//
// 反方向同样不能放宽：认宽了会把客户自己的本地代理（他的 Clash 在 7890）当成我们的，于是接管时
// 不记账，客户的设置就此丢了。所以既不猜也不放宽，只认守护报上来的那份记录。
//
// 生产两端的适配器与测试夹具共用这一份：⛔ 各写一份（夹具比生产松一档，测出来的绿就有一档是假的）。

/** ours.port 与 ours.knownPorts 合起来就是「我们用过/可能用的口」。非正整数一律丢掉。 */
export function ourPorts(ours) {
  const ports = [ours?.port, ...(Array.isArray(ours?.knownPorts) ? ours.knownPorts : [])]
  return new Set(ports.filter((port) => typeof port === 'number' && Number.isInteger(port) && port > 0))
}

/** 这个地址是不是我们自己的入口。host 要一样，端口要在记录里。 */
export function isOurProxy(value, ours) {
  return value?.host === ours?.host && ourPorts(ours).has(value?.port)
}
