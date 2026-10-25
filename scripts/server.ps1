param([ValidateSet('Status','Start','Stop','Open')][string]$Action='Status')
$ErrorActionPreference='Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $projectRoot 'config/project-development.json')) {
  $projectAction=if($Action -eq 'Open'){'launch'}else{$Action.ToLowerInvariant()}
  & (Join-Path $projectRoot 'app/tools/python/python.exe') -X utf8 -B (Join-Path $projectRoot 'scripts/project-local.py') $projectAction
  if($LASTEXITCODE -ne 0){throw 'Independent project operation failed'}
  return
}
$layout = Get-Content -LiteralPath (Join-Path $projectRoot 'project-layout.json') -Raw | ConvertFrom-Json
$configPath = Join-Path $projectRoot $layout.paths.config
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$statusPath = Join-Path $config.runtime_directory 'runtime-status.json'
switch ($Action) {
  'Open' { Start-Process -FilePath $layout.webUrl; return }
  'Start' {
    $task=Get-ScheduledTask -TaskName $layout.task
    if ($task.Actions.Execute -ne (Join-Path $projectRoot 'app\tools\python\python.exe')) { throw 'Scheduled task does not use this project' }
    if ($task.State -ne 'Running') { Enable-ScheduledTask -TaskName $layout.task | Out-Null; Start-ScheduledTask -TaskName $layout.task }
    $deadline=[DateTime]::UtcNow.AddSeconds(120)
    $ready=$false
    do {
      try {
        $state=Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
        $owner=Get-Process -Id $state.pid -ErrorAction SilentlyContinue
        $age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($state.at_utc)).TotalSeconds
        $ready=($state.state -eq 'running' -and $state.database_epoch -eq $config.database_epoch -and
          $owner -and $owner.Path -eq (Join-Path $projectRoot 'app\tools\python\python.exe') -and
          $age -ge -2 -and $age -lt 15 -and $state.transport.ready -eq $true -and
          $state.persistence.accepting -eq $true -and $state.persistence.writable -eq $true -and
          $state.persistence.writer.running -eq $true)
        if ($ready) { break }
      } catch { $ready=$false }
      Start-Sleep -Milliseconds 500
    } until ([DateTime]::UtcNow -ge $deadline)
    if (-not $ready) { throw 'Server not ready: inspect transport and persistence in runtime-status.json; no forced restart attempted' }
  }
  'Stop' {
    $state=Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    if ($state.state -notin @('running','degraded')) { throw 'No confirmed running service' }
    # The server accepts only a stop request for the current boot; never kills a writer.
    [IO.File]::WriteAllText((Join-Path $config.runtime_directory 'stop.request.json'),(@{boot_id=$state.boot_id}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    do {
      Start-Sleep -Milliseconds 500
      $state=Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    } until ($state.state -eq 'stopped' -or [DateTime]::UtcNow -ge $deadline)
    if ($state.state -ne 'stopped') { throw 'Graceful stop not confirmed; no force termination attempted' }
  }
}
$task=Get-ScheduledTask -TaskName $layout.task
$state=Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
[pscustomobject]@{Task=$layout.task;TaskState=[string]$task.State;Runtime=$state.state;Pid=$state.pid;Epoch=$state.database_epoch;Saved=$state.persistence.committed;Failed=$state.persistence.failed;Refused=$state.persistence.refused;Web=$layout.webUrl;Database=$config.database} | Format-List
