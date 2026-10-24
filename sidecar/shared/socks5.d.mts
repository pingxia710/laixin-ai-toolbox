import type { Socket } from 'node:net'

export declare function socks5Connect(options: {
  host: string
  port: number
  targetHost: string
  targetPort: number
  timeoutMs?: number
}): Promise<Socket>
