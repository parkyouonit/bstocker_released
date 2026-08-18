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

Start-StackApp -Root $bstockRoot -WebPort 4174 -ApiPort 8787
if (Test-Path -LiteralPath $bridgeRoot) {
  Start-StackApp -Root $bridgeRoot -WebPort 4175 -ApiPort 8788
}
