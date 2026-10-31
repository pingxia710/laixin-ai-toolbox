export type NetworkPhase = 'dns' | 'tcp' | 'tls' | 'proxy' | 'backend' | 'timeout' | 'unknown'
/** 证据制网络相位分类;与 app/main/network/net-phase.ts 同一张证据表(两侧各持一份,对照用例防漂移)。 */
export declare function classifyNetworkPhase(error: unknown): NetworkPhase
export declare function isNetworkPhase(value: unknown): boolean
