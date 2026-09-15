/** 我们用过/可能用的入口端口（ours.port + ours.knownPorts）。 */
export declare function ourPorts(ours: { port?: number; knownPorts?: readonly number[] } | undefined): Set<number>
/** 这个地址是不是我们自己的入口：host 一样、端口在记录里。⛔ 靠端口长什么样猜。 */
export declare function isOurProxy(
  value: { host?: string; port?: number } | undefined,
  ours: { host?: string; port?: number; knownPorts?: readonly number[] } | undefined
): boolean
