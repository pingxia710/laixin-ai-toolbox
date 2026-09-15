export type OfficialAccountState = 'signed-in' | 'signed-out' | 'not-installed' | 'unsupported' | 'unavailable'

export interface OfficialAccount {
  readonly accountKey?: string
  readonly state: OfficialAccountState
  readonly accountLabel: string | null
  readonly plan: string | null
}
