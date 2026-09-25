[CmdletBinding()]
param()
# Offline only: parses scripts and uses a fake download artifact. No administrator, Token or service.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
foreach ($name in @('cloudflare-verified.ps1', 'setup-remote-tunnel.ps1', 'uninstall-cloudflare-tunnel.ps1')) {
  $tokens = $null; $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw "PowerShell parse error in ${name}: $($errors[0])" }
}
. (Join-Path $PSScriptRoot 'cloudflare-verified.ps1')
if ($script:CloudflaredVersion -ne '2026.9.1' -or $script:CloudflaredSha256 -ne '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712') {
  throw 'Unexpected pinned upstream asset; review release metadata before updating the test.'
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("qqai-cloudflare-test-$([Guid]::NewGuid().ToString('N'))")
try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  $fixture = Join-Path $testRoot 'offline-fake.exe'
  [IO.File]::WriteAllText($fixture, 'TEST FIXTURE: not an executable and never executed')
  $fixtureHash = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash
  $download = { param($url, $destination) Copy-Item -LiteralPath $fixture -Destination $destination }
  $dir = Join-Path $testRoot 'install'
  $exe = Get-VerifiedCloudflared -DownloadIfMissing -InstallDirectory $dir -ExpectedSha256 $fixtureHash -DownloadUrl 'https://offline.invalid/fake.exe' -DownloadAction $download
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Offline fake download not stored.' }
  if ($exe -ne (Get-VerifiedCloudflared -InstallDirectory $dir -ExpectedSha256 $fixtureHash)) { throw 'Verified cached file not reused.' }
  $rejected = $false
  try { $null = Get-VerifiedCloudflared -DownloadIfMissing -InstallDirectory $dir -ExpectedSha256 ('0' * 64) -DownloadAction $download } catch { $rejected = $true }
  if (-not $rejected) { throw 'A mismatched cached file was accepted.' }
  [IO.File]::AppendAllText($exe, 'tampered')
  $rejected = $false
  try { $null = Get-VerifiedCloudflared -DownloadIfMissing -InstallDirectory $dir -ExpectedSha256 $fixtureHash -DownloadAction $download } catch { $rejected = $true }
  if (-not $rejected) { throw 'A tampered executable was accepted or silently replaced.' }
  Write-Host 'PASS: PowerShell parsing, pinned metadata, fake download verification, cached reuse, tamper refusal.'
} finally {
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
