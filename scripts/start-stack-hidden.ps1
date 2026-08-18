$ErrorActionPreference = 'Stop'

$bstockRoot = Split-Path -Parent $PSScriptRoot
$projectsRoot = Split-Path -Parent $bstockRoot
$bridgeRoot = Join-Path $projectsRoot 'Bridge'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

function Test-LocalPort([int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Start-StackApp([string]$Root, [int]$WebPort, [int]$ApiPort) {
  if ((Test-LocalPort $WebPort) -or (Test-LocalPort $ApiPort)) { return }
  $work = Join-Path $Root 'work'
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  Start-Process -FilePath $nodePath `
    -ArgumentList @('scripts/run-local.mjs') `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $work 'autostart.out.log') `
    -RedirectStandardError (Join-Path $work 'autostart.err.log')
}

function Start-BStockTunnel([string]$Root) {
  # The private bStocker connector exposes its metrics endpoint on this port.
  # A different system-wide Cloudflared service can be running at the same time,
  # so checking the process name alone is not sufficient.
  if (Test-LocalPort 20242) { return }

  $cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if (-not $cloudflared) { return }

  $cloudflaredRoot = Join-Path $env:USERPROFILE '.cloudflared'
  $configPath = Join-Path $cloudflaredRoot 'bstocker-config.yml'
  $tokenPath = Join-Path $cloudflaredRoot 'bstocker-token'
  if (-not (Test-Path -LiteralPath $configPath) -or -not (Test-Path -LiteralPath $tokenPath)) { return }

  $work = Join-Path $Root 'work'
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  Start-Process -FilePath $cloudflared.Source `
    -ArgumentList @('tunnel', '--config', "`"$configPath`"", 'run', '--token-file', "`"$tokenPath`"") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $work 'cloudflared-bstocker-autostart.out.log') `
    -RedirectStandardError (Join-Path $work 'cloudflared-bstocker-autostart.err.log')
}

Start-StackApp -Root $bstockRoot -WebPort 4174 -ApiPort 8787
if (Test-Path -LiteralPath $bridgeRoot) {
  Start-StackApp -Root $bridgeRoot -WebPort 4175 -ApiPort 8788
}
Start-BStockTunnel -Root $bstockRoot
