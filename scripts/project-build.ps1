param([ValidateSet('Build','Test','Publish')][string]$Action='Publish')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
& (Join-Path $projectRoot 'scripts/native.ps1') -Action $Action -DotnetPath (Join-Path $projectRoot 'tools/dotnet/dotnet.exe')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
