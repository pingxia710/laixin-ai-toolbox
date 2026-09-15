export interface CcSwitchFixtureSnapshot {
  readonly model: string
  readonly modelProvider: string
  readonly providerName: string
  readonly providerBaseUrl: string
  readonly mcpCommand: string
}

export interface CcSwitchAcceptanceBaseline {
  readonly authHash: string
  readonly configHash: string
  readonly config: CcSwitchFixtureSnapshot | undefined
}

export function nativeRouteModelAccepted(
  shell: string,
  configuredModel: string | undefined,
  observedModel: string | undefined,
  allowedModels: readonly string[]
): boolean

export function newlyPrependedGatewayRecords<T>(before: readonly T[], after: readonly T[]): readonly T[]

export interface NativeClientEvidence {
  readonly requests: number
  readonly succeeded: boolean
  readonly cancelled: number
  readonly failure: string | null
}

export function nativeClientEvidence(records: readonly unknown[], shell: string, provider: string): NativeClientEvidence

export function expectedProviderMismatchSuggestion(provider: string): string | undefined

export function expectedProviderMismatchAccepted(
  provider: string,
  expectedSuggestion: string,
  attempt: { readonly ok?: boolean; readonly code?: string; readonly suggestedProvider?: string } | undefined
): boolean

export function isolatedNativeEnvironment(
  platform: string,
  home: string,
  hermesHome: string,
  temporaryDirectory: string,
  trustedWindowsRoot: string
): Readonly<Record<string, string>>

export function ccSwitchFixtureSnapshot(contents: unknown): CcSwitchFixtureSnapshot | undefined

export function sameCcSwitchFixture(
  before: CcSwitchFixtureSnapshot | undefined,
  after: CcSwitchFixtureSnapshot | undefined
): boolean

export function ccSwitchFixtureIsDetachedFromToolbox(contents: unknown): boolean

export function ccSwitchDetachAccepted(
  before: CcSwitchAcceptanceBaseline | undefined,
  afterAuthHash: string | undefined,
  afterConfigHash: string | undefined,
  selected: string | null | undefined,
  authentication: { readonly state?: string; readonly reason?: string } | undefined,
  contents: unknown
): boolean

export function ccSwitchRestoreAccepted(
  before: CcSwitchAcceptanceBaseline | undefined,
  afterAuthHash: string | undefined,
  afterConfigHash: string | undefined,
  selected: string | null | undefined,
  contents: unknown
): boolean
