export declare const CONNECTION_FLAGS: {
  readonly direct: 1; readonly proxy: 2; readonly autoProxyUrl: 4; readonly autoDetect: 8
}
/** 认不认得这份连接设置 blob；认不得返回 undefined，调用方原样不动。 */
export declare function readConnectionSettings(blob: unknown): { version: number; counter: number; flags: number } | undefined
/** 「自动检测设置」开着吗；认不得格式返回 undefined（⛔ 当成 false）。 */
export declare function autoDetectEnabled(blob: unknown): boolean | undefined
/** 关掉「自动检测设置」，其余字节不动；认不得格式或本来就关着返回 undefined。 */
export declare function withAutoDetectDisabled(blob: unknown): Uint8Array | undefined
/** W2-1:所有权/还原判据只看 autoDetect 位;有一边认不得格式返回 undefined(调用方回落字节比)。 */
export declare function autoDetectBitsEqual(leftHex: unknown, rightHex: unknown): boolean | undefined
export declare function blobToHex(blob: Uint8Array): string
export declare function hexToBlob(hex: unknown): Uint8Array | undefined
/** 「自动检测设置」这一项的受管项；不该动时返回 undefined。生产适配器与夹具共用。 */
export declare function autoDetectManagedItem(
  current: { type?: string; data?: string } | null | undefined,
  ref: { service: string; item: string }
): { ref: { service: string; item: string }; value: { type: string; data: string } } | undefined

