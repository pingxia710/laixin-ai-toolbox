export interface VlessCredential { readonly uuid: string; readonly publicKey: string; readonly shortId: string; readonly serverName: string; readonly spiderX?: string }
export declare function validNodeHost(host: unknown): boolean
export declare function validVerifyUrl(value: unknown): boolean
export declare function validVerifyFallbackUrl(primary: unknown, fallback: unknown): boolean
export declare function parseVlessCredential(value: unknown): VlessCredential
export declare function buildVlessOutbound(node: { host: string; port: number }, credential: VlessCredential): Record<string, unknown>
