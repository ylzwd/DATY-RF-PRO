[CmdletBinding()]
param(
    [ValidateSet('Inspect','Sign')][string]$Mode = 'Inspect',
    [string]$SourceDirectory,
    [string]$ManifestPath = (Join-Path $PSScriptRoot 'release-input.json'),
    [string]$OutputDirectory,
    [string]$SignToolPath,
    [string]$CertificateThumbprint,
    [ValidateSet('CurrentUser','LocalMachine')][string]$CertificateStore = 'CurrentUser',
    [string]$TimestampUrl
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-PlainPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Linked path is not permitted: $current"
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
    return $full.TrimEnd('\')
}

function Get-ReleaseFiles([string]$Directory) {
    # Explicit traversal checks a link before descending into it.
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($Directory)
    while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked entry: $($item.FullName)" }
            if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) } else { $item }
        }
    }
}

function Assert-Input([string]$Directory, $Manifest) {
    $expected = @{}
    foreach ($entry in $Manifest.files) {
        $rel = [string]$entry.path
        if ($rel -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or $expected.ContainsKey($rel)) { throw "Invalid manifest path: $rel" }
        if ($entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw "Invalid hash: $rel" }
        $expected[$rel] = $entry
    }
    $actual = @(Get-ReleaseFiles $Directory)
    if ($actual.Count -ne $expected.Count) { throw 'Release file count changed; generate and review a new manifest.' }
    foreach ($file in $actual) {
        $rel = $file.FullName.Substring($Directory.Length + 1).Replace('\','/')
        if (-not $expected.ContainsKey($rel)) { throw "Unexpected file: $rel" }
        if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne $expected[$rel].sha256) { throw "Input hash changed: $rel" }
        if ($file.Extension -in '.exe','.dll') {
            $status = [string](Get-AuthenticodeSignature -LiteralPath $file.FullName).Status
            if ($status -notin 'Valid','NotSigned' -or $status -ne $expected[$rel].signature) { throw "Unexpected signature state: $rel / $status" }
        }
    }
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.format -ne 'daty-native-signing-input-v1') { throw 'Unsupported input manifest.' }
if (-not $SourceDirectory) { $SourceDirectory = $manifest.source }
if (-not [IO.Path]::IsPathRooted($SourceDirectory)) { $SourceDirectory = Join-Path (Join-Path $PSScriptRoot '../../..') $SourceDirectory }
$source = Assert-PlainPath $SourceDirectory
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Release directory is missing.' }
Assert-Input $source $manifest
$targets = @($manifest.files | Where-Object signature -eq 'NotSigned')
if ($targets.Count -eq 0) { throw 'No unsigned release targets.' }

if ($Mode -eq 'Inspect') {
    [pscustomobject]@{
        Mode = 'Inspect'; Version = $manifest.version; InputHashesMatch = $true
        TotalFiles = $manifest.files.Count
        ExistingValidSignatures = @($manifest.files | Where-Object signature -eq 'Valid').Count
        FilesToSign = @($targets.path)
        SigningPerformed = $false
        CertificatesAvailable = @(Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert | Where-Object HasPrivateKey).Count
    }
    return
}

if ($CertificateThumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'Select an issued code-signing certificate by its exact thumbprint.' }
$certPath = "Cert:\$CertificateStore\My\$CertificateThumbprint"
if (-not (Test-Path -LiteralPath $certPath)) { throw 'Signing certificate not found. Complete CA identity verification first.' }
$cert = Get-Item -LiteralPath $certPath
if (-not $cert.HasPrivateKey -or $cert.NotBefore -gt (Get-Date) -or $cert.NotAfter -le (Get-Date)) { throw 'Certificate is expired, not yet valid, or has no accessible private key.' }
if ($cert.Subject -eq $cert.Issuer) { throw 'Self-issued certificates are not accepted.' }
if (@($cert.EnhancedKeyUsageList | Where-Object { [string]$_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }).Count -eq 0) { throw 'Code-signing EKU is required.' }
if ($cert.PublicKey.Oid.Value -ne '1.2.840.113549.1.1.1') { throw 'An RSA code-signing certificate is required for Smart App Control.' }
$chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
try {
    $chain.ChainPolicy.RevocationMode = 'Online'
    $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)
    $chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
    if (-not $chain.Build($cert)) { throw 'Certificate chain or revocation verification failed.' }
} finally { $chain.Dispose() }
# Chain validation uses existing Windows trust; public-CA issuance must also be verified with the provider.
if (-not $SignToolPath -or -not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) { throw 'Provide the verified Microsoft SignTool path.' }
$tool = Assert-PlainPath $SignToolPath
$toolSignature = Get-AuthenticodeSignature -LiteralPath $tool
if ($toolSignature.Status -ne 'Valid' -or $toolSignature.SignerCertificate.Subject -notmatch '(^|, )CN=Microsoft Corporation(,|$)') { throw 'SignTool must have a valid Microsoft signature.' }
$stamp = $null
if (-not [Uri]::TryCreate($TimestampUrl,[UriKind]::Absolute,[ref]$stamp) -or $stamp.Scheme -notin 'http','https' -or $stamp.UserInfo -or -not $stamp.Host) { throw 'Provide the CA documented RFC3161 timestamp URL.' }
if (-not $OutputDirectory) { throw 'A new, separate output directory is required.' }
$output = Assert-PlainPath $OutputDirectory
if ((Test-Path -LiteralPath $output) -or $output.StartsWith($source + '\',[StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($output + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be new and outside the input tree.' }

[IO.Directory]::CreateDirectory($output) | Out-Null
foreach ($entry in $manifest.files) {
    $destination = Join-Path $output $entry.path
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.File]::Copy((Join-Path $source $entry.path),$destination,$false)
}
Assert-Input $output $manifest
'Incomplete signing output. Do not distribute.' | Set-Content -LiteralPath (Join-Path $output 'SIGNING-INCOMPLETE.txt') -Encoding UTF8
foreach ($entry in $targets) {
    $file = Join-Path $output $entry.path
    $arguments = @('sign','/v','/s','My','/sha1',$CertificateThumbprint,'/fd','SHA256','/tr',$TimestampUrl,'/td','SHA256','/d','DATY RF PRO Windows Native 0.2.0')
    if ($CertificateStore -eq 'LocalMachine') { $arguments += '/sm' }
    # Token PIN/cloud login is handled interactively by the provider; no secrets in arguments or logs.
    & $tool @arguments $file
    if ($LASTEXITCODE -ne 0) { throw "Signing or timestamping failed: $($entry.path). Output remains incomplete." }
    & $tool verify /pa /all /v /tw $file
    if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed: $($entry.path)" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint -or $null -eq $signature.TimeStamperCertificate) { throw "Signer or timestamp check failed: $($entry.path)" }
}
$result = foreach ($entry in $manifest.files) {
    $file = Join-Path $output $entry.path
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($entry.signature -ne 'NotSigned' -and $hash -ne $entry.sha256) { throw "Non-target changed: $($entry.path)" }
    if ($entry.signature -and (Get-AuthenticodeSignature -LiteralPath $file).Status -ne 'Valid') { throw "Final signature invalid: $($entry.path)" }
    [pscustomobject]@{ path=$entry.path; sha256=$hash; signedNow=($entry.signature -eq 'NotSigned') }
}
Assert-Input $source $manifest
$receipt = [ordered]@{ status='signatures_verified'; runtimeAcceptance='NOT_RUN'; version=$manifest.version; utc=[DateTime]::UtcNow.ToString('o'); publisher=$cert.Subject; certificateThumbprint=$cert.Thumbprint; timestampUrl=$TimestampUrl; files=@($result) }
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'signing-receipt.json') -Encoding UTF8
# Only the marker created above is removed, never release data or directories.
Remove-Item -LiteralPath (Join-Path $output 'SIGNING-INCOMPLETE.txt')
Write-Output "Signatures verified in $output. Runtime and Smart App Control acceptance still required."
