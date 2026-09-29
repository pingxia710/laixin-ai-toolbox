export type FaceCounts = Record<string, Record<'written' | 'original' | 'changed' | 'unreadable', number>>
export declare function summarizeProxyFaces(entries: unknown[], adapter: {
  read(ref: { service: string; item: string }): unknown
  valuesEqual?(left: unknown, right: unknown, ref: { service: string; item: string }): boolean
}): FaceCounts
export declare function formatDaemonLogLine(line: string, options: { now: number; pid: number; runId?: string }): string
export declare function probeProxyFaces(dataDir: string, adapterPath: string): Promise<FaceCounts | undefined>
