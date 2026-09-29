export interface ActiveNetworkPath {
  readonly device: string
  readonly service: string
}

export type ActiveNetworkPathResolution =
  | { readonly status: 'resolved'; readonly path: ActiveNetworkPath }
  | { readonly status: 'changed' | 'unknown' }

export declare function resolveActiveNetworkPath(
  run: (file: string, args: readonly string[]) => string
): ActiveNetworkPathResolution
