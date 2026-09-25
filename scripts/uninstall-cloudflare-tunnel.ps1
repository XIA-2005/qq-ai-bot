[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cloudflare-verified.ps1')

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Please run this script as Administrator.'
}
if (-not (Get-Service cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host 'No cloudflared Windows service is installed.'
  exit 0
}
# Never execute a different cloudflared.exe found on PATH while elevated.
$cloudflared = Get-VerifiedCloudflared
& $cloudflared service uninstall
if ($LASTEXITCODE -ne 0) { throw "cloudflared service uninstall failed ($LASTEXITCODE)." }
Write-Host 'Service removed. Review Cloudflare Tunnel credentials and revoke/rotate the connector Token in Zero Trust if no longer needed.'
