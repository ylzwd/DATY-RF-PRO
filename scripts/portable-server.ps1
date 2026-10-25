param([ValidateSet('Start','Stop','Status')][string]$Action='Start')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$python=Join-Path $projectRoot 'app\tools\python\python.exe'
$helper=Join-Path $PSScriptRoot 'portable-runtime.py'
function Invoke-Helper([string[]]$Arguments) {
  $value=& $python -B $helper @Arguments
  if ($LASTEXITCODE -ne 0) { throw '启动检查未通过，请按上方错误处理；日志位于 runtime 文件夹。' }
  return ($value | ConvertFrom-Json)
}
try {
  if (-not [Environment]::Is64BitOperatingSystem) { throw '需要 Windows 10/11 64 位系统。' }
  $info=Invoke-Helper @('info')
  $task=Get-ScheduledTask -TaskName $info.task -ErrorAction SilentlyContinue
  if ($task) {
    $expected='-u -B "'+(Join-Path $projectRoot 'app\service-launch.py')+'" --config "'+(Join-Path $projectRoot 'config\runtime-config.json')+'"'
    if ($task.Actions.Execute -ne $python -or $task.Actions.Arguments -ne $expected) { throw '同一迁移包已在另一个目录安装。请使用原安装目录；不会覆盖其他任务。' }
  }
  if ($Action -eq 'Status') {
    if (Test-Path -LiteralPath (Join-Path $projectRoot 'runtime\runtime-status.json')) { Get-Content -LiteralPath (Join-Path $projectRoot 'runtime\runtime-status.json') -Raw -Encoding UTF8 }
    else { Write-Host '尚未启动。' }
    exit 0
  }
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments='-NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Action '+$Action
    $child=Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru -Wait
    exit $child.ExitCode
  }
  if ($Action -eq 'Stop') {
    if (-not $task -or $task.State -ne 'Running') { throw '当前迁移服务没有运行。' }
    Invoke-Helper @('stop') | Out-Null
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    do {
      Start-Sleep -Milliseconds 500
      $state=Get-Content -LiteralPath (Join-Path $projectRoot 'runtime\runtime-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    } until ($state.state -eq 'stopped' -or [DateTime]::UtcNow -ge $deadline)
    if ($state.state -ne 'stopped') { throw '服务尚未确认正常停止，未强制结束进程。' }
    Write-Host '服务器已正常停止。';exit 0
  }
  if ($task -and $task.State -eq 'Running') {
    Invoke-Helper @('health') | Out-Null
    $layout=Get-Content -LiteralPath (Join-Path $projectRoot 'project-layout.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Start-Process -FilePath $layout.webUrl
    exit 0
  }
  $addresses=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress -Unique)
  if ($addresses.Count -eq 0) { throw '未检测到有效局域网 IPv4 地址，请连接局域网后重试。' }
  if ($addresses -contains $info.sourceHost) { $primary=$info.sourceHost }
  else {
    $network=Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    if ($network) { $primary=$network.IPv4Address.IPAddress | Select-Object -First 1 } else { $primary=$addresses[0] }
  }
  $hostList=(@('127.0.0.1')+$addresses) -join ','
  Invoke-Helper @('preflight','--hosts',$hostList) | Out-Null
  $installMarker=Join-Path $projectRoot 'config\portable-install.json'
  if (-not (Test-Path -LiteralPath $installMarker)) {
    Add-Type -AssemblyName System.Windows.Forms
    $message="确认原服务器已关闭后继续迁移。`n`n保留数据库和接收机配对；本机地址：$primary。`n首次设置会恢复专用安全目录、信任随包原 CA、为本程序开放专用/域网络的本地子网 TCP 8080/8083，并创建按需启动任务（不开机自启）。`n`nCA SHA256：$($info.caSha256)`n`n该压缩包包含服务器私钥，只能交给受信管理员。是否继续？"
    $answer=[Windows.Forms.MessageBox]::Show($message,'DATY RF PRO 首次迁移设置','YesNo','Warning')
    if ($answer -ne 'Yes') { exit 2 }
  }
  $prepared=Invoke-Helper @('prepare','--hosts',$hostList,'--primary',$primary)
  $cert=New-Object Security.Cryptography.X509Certificates.X509Certificate2($prepared.ca)
  $trusted=Get-ChildItem Cert:\LocalMachine\Root | Where-Object Thumbprint -eq $cert.Thumbprint
  if (-not $trusted) { Import-Certificate -FilePath $prepared.ca -CertStoreLocation Cert:\LocalMachine\Root | Out-Null }
  $ruleName=$info.task+'_LAN'
  $rule=Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  if (-not $rule) { New-NetFirewallRule -Name $ruleName -DisplayName 'DATY RF PRO 迁移版局域网' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080,8083 -Program $python -RemoteAddress LocalSubnet -Profile Private,Domain | Out-Null }
  if (-not $task) {
    $actionArgs='-u -B "'+(Join-Path $projectRoot 'app\service-launch.py')+'" --config "'+$prepared.config+'"'
    $taskAction=New-ScheduledTaskAction -Execute $python -Argument $actionArgs -WorkingDirectory (Join-Path $projectRoot 'app')
    $taskPrincipal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $info.task -Action $taskAction -Principal $taskPrincipal -Settings $settings -Description 'DATY RF PRO portable migration; manual start; original data and pairing retained' | Out-Null
  }
  Start-ScheduledTask -TaskName $info.task
  Invoke-Helper @('wait') | Out-Null
  Write-Host ('启动成功：'+$prepared.url)
  Start-Process -FilePath $prepared.url
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  try { Add-Type -AssemblyName System.Windows.Forms;[Windows.Forms.MessageBox]::Show($_.Exception.Message,'DATY RF PRO 启动失败','OK','Error') | Out-Null } catch {}
  exit 1
}
