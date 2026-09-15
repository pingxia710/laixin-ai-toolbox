export function displayReleaseVersion(value: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  return match ? `V${match[1]}.${match[2]}${match[3]}` : value
}
