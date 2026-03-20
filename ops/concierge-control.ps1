param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("ligar", "desligar", "status")]
  [string]$Acao
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot ".concierge.pid"
$LogFile = Join-Path $ProjectRoot ".concierge.log"
$NodePath = Join-Path $ProjectRoot "index.js"

function Get-PidsListeningOnPort3000 {
  $matches = netstat -ano | Select-String "LISTENING"
  $pids = @()

  foreach ($line in $matches) {
    $raw = ($line.ToString() -replace "\s+", " ").Trim()
    if ($raw -match ":3000\s+\S+\s+LISTENING\s+(\d+)$") {
      $pids += [int]$matches[1]
    }
  }

  return ($pids | Sort-Object -Unique)
}

function Get-ConciergePids {
  $pids = @()

  if (Test-Path $PidFile) {
    $savedPid = Get-Content $PidFile | Select-Object -First 1
    if ($savedPid -match "^\d+$") {
      $pids += [int]$savedPid
    }
  }

  $pids += Get-PidsListeningOnPort3000
  $pids = $pids | Sort-Object -Unique

  $alive = @()
  foreach ($p in $pids) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match "^node$") {
      $alive += $p
    }
  }

  return ($alive | Sort-Object -Unique)
}

function Start-Concierge {
  $running = Get-ConciergePids
  if ($running.Count -gt 0) {
    Write-Output "Concierge ja esta ligado (PID(s): $($running -join ', '))."
    return
  }

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-Output "Falha ao ligar: comando 'node' nao encontrado no PATH."
    return
  }

  $proc = Start-Process -FilePath $nodeCmd.Source `
    -ArgumentList "`"$NodePath`"" `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError (Join-Path $ProjectRoot ".concierge.err.log") `
    -PassThru

  if ($proc -and $proc.Id) {
    Set-Content -Path $PidFile -Value $proc.Id
    Write-Output "Concierge ligado com sucesso (PID: $($proc.Id))."
    Write-Output "Log: $LogFile"
  } else {
    Write-Output "Falha ao ligar o Concierge."
  }
}

function Stop-Concierge {
  $stopped = @()

  if (Test-Path $PidFile) {
    $savedPid = Get-Content $PidFile | Select-Object -First 1
    if ($savedPid -match "^\d+$") {
      Stop-Process -Id ([int]$savedPid) -Force
      if ($?) { $stopped += [int]$savedPid }
    }
    Remove-Item $PidFile -Force
  }

  $running = Get-ConciergePids
  foreach ($procId in $running) {
    Stop-Process -Id $procId -Force
    if ($?) { $stopped += $procId }
  }

  $stopped = $stopped | Sort-Object -Unique

  if ($stopped.Count -gt 0) {
    Write-Output "Concierge desligado. PID(s) encerrados: $($stopped -join ', ')."
  } else {
    Write-Output "Nenhum processo do Concierge estava rodando."
  }
}

function Get-Status {
  $running = Get-ConciergePids
  if ($running.Count -gt 0) {
    Write-Output "Status: LIGADO"
    Write-Output "PID(s): $($running -join ', ')"
  } else {
    Write-Output "Status: DESLIGADO"
  }
}

switch ($Acao) {
  "ligar" { Start-Concierge; break }
  "desligar" { Stop-Concierge; break }
  "status" { Get-Status; break }
}
