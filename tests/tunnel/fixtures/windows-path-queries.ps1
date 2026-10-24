param([Parameter(Mandatory = $true)][string]$TargetScript)

# Pure command fixtures: never read or change this machine's adapters or registry.
function Get-NetRoute {
  [CmdletBinding()]
  param([string]$AddressFamily, [string]$DestinationPrefix)
  [PSCustomObject]@{ InterfaceIndex = 12; RouteMetric = 5 }
}
function Get-NetIPInterface {
  [CmdletBinding()]
  param([string]$AddressFamily, [uint32]$InterfaceIndex)
  [PSCustomObject]@{ InterfaceMetric = 10 }
}
function Get-NetAdapter {
  [CmdletBinding()]
  param([uint32[]]$InterfaceIndex, [switch]$IncludeHidden)
  if ($InterfaceIndex.Count -ne 1 -or $InterfaceIndex[0] -ne 12 -or -not $IncludeHidden) { throw 'Unexpected adapter query' }
  [PSCustomObject]@{ InterfaceIndex = 12; InterfaceGuid = $env:TOOLBOX_TEST_INTERFACE_GUID; Virtual = $false }
}
& $TargetScript
exit $LASTEXITCODE
