export interface ApiNetworkBinding {
  readonly port: number
  readonly pid: number
  readonly bootId: string
  readonly identitySecret: string
  readonly bridgePort: number
}
export interface ApiNetworkUse { readonly targets: readonly string[] }
export declare const API_NETWORK_PATH: string
export declare function apiNetworkProof(binding: ApiNetworkBinding, action: string, nonce: string): string
export declare function probeApiNetwork(binding: ApiNetworkBinding): Promise<ApiNetworkUse | undefined>
