export declare function wininetValuesEqual(left: unknown, right: unknown, ref?: { service: string; item: string }): boolean

export declare function parseProxyServer(data: unknown): { kind: 'http' | 'socks'; host: string; port: number } | undefined
