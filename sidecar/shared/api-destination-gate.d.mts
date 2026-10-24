export interface ApiDestinationGate {
  restrict(targets: readonly string[] | undefined): void
  track(close: () => void): { consume(chunk: Buffer): boolean; forget(): void }
}
export declare function createApiDestinationGate(): ApiDestinationGate
