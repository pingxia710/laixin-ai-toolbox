# Read-only registry fallback and explicit WinINET notification. No machine settings are written.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$items = @('ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL')
$settingsPath = 'Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$policyPath = 'Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  switch ($request.operation) {
    'read' {
      if ($items -notcontains $request.item) { throw 'Invalid item' }
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($settingsPath, $false)
      try {
        if ($null -eq $key -or $key.GetValueNames() -notcontains $request.item) {
          [Console]::WriteLine('null')
        } else {
          $kind = $key.GetValueKind($request.item).ToString()
          $value = $key.GetValue($request.item, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          $type = switch ($kind) { 'DWord' { 'REG_DWORD' }; 'String' { 'REG_SZ' }; 'ExpandString' { 'REG_EXPAND_SZ' }; default { throw 'Unsupported registry type' } }
          if ($kind -eq 'DWord') { $value = ([long]$value -band [long]4294967295).ToString() }
          [Console]::WriteLine((@{ type = $type; data = [string]$value } | ConvertTo-Json -Compress))
        }
      } finally { if ($null -ne $key) { $key.Dispose() } }
    }
    'policy' {
      $managed = $false
      foreach ($hive in @([Microsoft.Win32.Registry]::CurrentUser, [Microsoft.Win32.Registry]::LocalMachine)) {
        $key = $hive.OpenSubKey($policyPath, $false)
        try {
          if ($null -ne $key) {
            foreach ($item in $items) { if ($key.GetValueNames() -contains $item) { $managed = $true } }
            if ($key.GetValue('ProxySettingsPerUser', 1) -eq 0) { $managed = $true }
          }
        } finally { if ($null -ne $key) { $key.Dispose() } }
      }
      [Console]::WriteLine(($managed | ConvertTo-Json -Compress))
    }
    'path' {
      # Reuse must prove the result belongs to the same active path.  The route
      # plus adapter GUID distinguishes a TUN/VPN/default-route switch without
      # exposing its name, address, gateway, PAC or process information.
      $candidates = @(
        Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
        ForEach-Object {
          $ip = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $_.InterfaceIndex -ErrorAction Stop
          [PSCustomObject]@{ Route = $_; Metric = ([int64]$_.RouteMetric + [int64]$ip.InterfaceMetric) }
        } |
        Sort-Object Metric, @{ Expression = { $_.Route.InterfaceIndex } }
      )
      if ($candidates.Count -lt 1) { throw 'Default route unavailable' }
      # Return every candidate to the JS identity guard. It alone rejects an
      # equal-metric ECMP/multi-active set instead of sorting InterfaceIndex and
      # pretending a guessed interface was the active customer path.
      $identities = @($candidates | ForEach-Object {
        $route = $_.Route
        $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -IncludeHidden -ErrorAction Stop
        # Windows can expose InterfaceGuid in brace-wrapped form. Normalize the
        # value, not its ownership: an absent or empty GUID is still unprovable.
        $identity = [Guid]::Empty
        if (-not [Guid]::TryParse([string]$adapter.InterfaceGuid, [ref]$identity) -or $identity -eq [Guid]::Empty) { throw 'Adapter identity unavailable' }
        $guid = $identity.ToString('D')
        @{ metric = [int64]$_.Metric; interfaceIndex = [int]$route.InterfaceIndex; interfaceGuid = $guid; kind = $(if ($adapter.Virtual -eq $true) { 'virtual-tun' } else { 'network-interface' }) }
      })
      [Console]::WriteLine(($identities | ConvertTo-Json -Compress))
    }
    'notify' {
      $source = @'
using System;
using System.Runtime.InteropServices;
public static class ToolboxWinInet {
  [DllImport("wininet.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool InternetSetOption(IntPtr handle, int option, IntPtr buffer, int length);
}
'@
      # Add-Type compiles C# on every fresh PowerShell process (seconds on a cold machine). Cache the
      # compiled assembly per user and load that instead; fall back to in-memory compile if the cache fails.
      $cacheDir = Join-Path $env:LOCALAPPDATA 'laixin-ai-toolbox'
      $cached = Join-Path $cacheDir 'wininet-notify-v1.dll'
      $loaded = $false
      if (Test-Path -LiteralPath $cached) {
        try { Add-Type -Path $cached; $loaded = $true } catch { $loaded = $false }
      }
      if (-not $loaded) {
        try {
          New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
          Add-Type -TypeDefinition $source -OutputAssembly $cached -OutputType Library
          Add-Type -Path $cached
          $loaded = $true
        } catch { $loaded = $false }
      }
      if (-not $loaded) { Add-Type -TypeDefinition $source }
      # SETTINGS_CHANGED (39) and REFRESH (37) reload registry settings for existing applications.
      foreach ($option in @(39, 37)) {
        if (-not [ToolboxWinInet]::InternetSetOption([IntPtr]::Zero, $option, [IntPtr]::Zero, 0)) { throw 'WinINET notification failed' }
      }
      [Console]::WriteLine('true')
    }
    default { throw 'Invalid operation' }
  }
} catch {
  [Console]::Error.WriteLine('WININET_ACCESS_FAILED')
  exit 1
}
