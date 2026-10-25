param([ValidateSet('Build','Test','Publish')][string]$Action='Build',[string]$DotnetPath,[string]$OutputDirectory)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if (-not $DotnetPath -and (Test-Path -LiteralPath (Join-Path $projectRoot 'tools/dotnet/dotnet.exe'))) { $DotnetPath=Join-Path $projectRoot 'tools/dotnet/dotnet.exe' }
if (-not $DotnetPath) {
  $local=Join-Path $projectRoot 'config\development.local.json'
  if (Test-Path -LiteralPath $local) { $DotnetPath=(Get-Content -LiteralPath $local -Raw|ConvertFrom-Json).dotnetSdk }
  else { $DotnetPath=(Get-Command dotnet -ErrorAction Stop).Source }
}
if (-not (Test-Path -LiteralPath $DotnetPath)) { throw 'Pass -DotnetPath for the .NET 10.0.401 SDK executable' }
if(Test-Path -LiteralPath (Join-Path $projectRoot 'config/project-development.json')) {
  $env:DOTNET_ROOT=Split-Path -Parent $DotnetPath
  $env:DOTNET_CLI_HOME=Join-Path $projectRoot 'tools/dotnet-home'
  $env:NUGET_PACKAGES=Join-Path $projectRoot 'tools/nuget-packages'
  $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
}
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false';$env:DOTNET_CLI_TELEMETRY_OPTOUT='1';$env:DOTNET_NOLOGO='1'
Push-Location (Join-Path $projectRoot 'native')
try {
  & $DotnetPath restore 'DATY.RF.Native.slnx' --locked-mode -p:NuGetAudit=false
  if ($LASTEXITCODE -ne 0) { throw 'Locked native dependency restore failed' }
  & $DotnetPath build 'DATY.RF.Native.slnx' -c Release --no-restore
  if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
  if ($Action -eq 'Test') {
    $runtimeTools=Join-Path $projectRoot 'app\tools'
    $developmentFile=Join-Path $projectRoot 'config\development.local.json'
    if(Test-Path -LiteralPath $developmentFile){$developmentConfig=Get-Content -LiteralPath $developmentFile -Raw|ConvertFrom-Json;if($developmentConfig.runtimeTools){$runtimeTools=$developmentConfig.runtimeTools}}
    $env:DATY_MONITORING_RULES_FIXTURE=Join-Path $projectRoot 'verification\monitoring-rules-fixture.json'
    & (Join-Path $runtimeTools 'python\python.exe') -X utf8 -B (Join-Path $projectRoot 'scripts\export-monitoring-fixture.py') $env:DATY_MONITORING_RULES_FIXTURE
    if($LASTEXITCODE -ne 0){throw 'Server monitoring fixture export failed'}
    & $DotnetPath run --project 'tests\Daty.Native.Tests\Daty.Native.Tests.csproj' -c Release --no-build -- (Join-Path $projectRoot 'verification\native-core.json')
    if ($LASTEXITCODE -ne 0) { throw 'Native core checks failed' }
    & $DotnetPath run --project 'tests\Daty.Native.Contracts.Tests\Daty.Native.Contracts.Tests.csproj' -c Release --no-build
    if ($LASTEXITCODE -ne 0) { throw 'Native contract checks failed' }
  }
  if ($Action -eq 'Publish') {
    $bundleCatalog=Get-Content -LiteralPath (Join-Path $projectRoot 'native/assets/plugin-bundles.json') -Raw|ConvertFrom-Json
    foreach($bundle in $bundleCatalog){
      if([IO.Path]::GetFileName($bundle.fileName) -ne $bundle.fileName){throw 'Invalid reviewed bundle name'}
      $bundleFile=Join-Path $projectRoot ('native/assets/plugin-bundles/'+$bundle.fileName)
      if(!(Test-Path -LiteralPath $bundleFile) -or (Get-Item -LiteralPath $bundleFile).Length -ne $bundle.bytes -or (Get-FileHash -LiteralPath $bundleFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $bundle.sha256){throw 'Missing or changed offline dependency bundle; run scripts/build-plugin-offline-bundle.py with the reviewed original installer'}
    }
    if (-not $OutputDirectory) { $OutputDirectory=Join-Path $projectRoot 'native\publish\r19-native-0.4.41-dev1' }
    & $DotnetPath publish 'src\Daty.Native.App\Daty.Native.App.csproj' -c Release -r win-x64 --self-contained true -p:RestoreLockedMode=true -p:NuGetAudit=false -p:PublishSingleFile=false -p:DebugType=None -p:DebugSymbols=false -o $OutputDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Native publication failed' }
    Copy-Item -LiteralPath 'THIRD-PARTY-NOTICES.md' -Destination $OutputDirectory -Force
    Copy-Item -LiteralPath 'licenses' -Destination $OutputDirectory -Recurse -Force
    Write-Host ('Development package: ' + $OutputDirectory + '\DATY.RF.Native.exe')
    Write-Host 'Unsigned development build. Compilation/publication is not runtime or UI acceptance.'
  }
} finally { Pop-Location }
