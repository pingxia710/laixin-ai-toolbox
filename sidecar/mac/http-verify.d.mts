export declare class HttpVerifyError extends Error {
  constructor(message: string)
}
export declare function verifyHttpExitIp(socket: unknown, url: URL, timeoutMs?: number): Promise<string>
