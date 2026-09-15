export interface FrameLike {
  readonly url: string
}

export interface MainFrameOwner {
  readonly mainFrame: FrameLike | null
}

export function isAllowedBridgeSource(
  senderFrame: FrameLike | null,
  owner: MainFrameOwner,
  entryUrl: string
): boolean {
  return (
    senderFrame !== null &&
    senderFrame === owner.mainFrame &&
    sourceIdentity(senderFrame.url) === sourceIdentity(entryUrl)
  )
}

export function isAllowedEntryUrl(candidateUrl: string, entryUrl: string): boolean {
  return sourceIdentity(candidateUrl) === sourceIdentity(entryUrl)
}

function sourceIdentity(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol === 'file:') {
    return parsed.href
  }
  return `${parsed.origin}${parsed.pathname}`
}
