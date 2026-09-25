[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cloudflare-verified.ps1')

$domain = 'example.com'
$publicHost = 'qqbot.example.com'
$publicUrl = "https://$publicHost"
$originUrl = 'http://127.0.0.1:5188'

function Stop-WithMessage([string]$message, [int]$code) {
  Write-Host "[ERROR] $message" -ForegroundColor Red
  exit $code
}

Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host ' QQ AI Bot - example.com fixed remote connector' -ForegroundColor Cyan
Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host "Public URL: $publicUrl"
Write-Host "Local origin: $originUrl"
Write-Host ''

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Stop-WithMessage 'Run the root setup CMD file as Administrator.' 1
}

try {
  $nameServers = @(Resolve-DnsName $domain -Type NS -ErrorAction Stop |
      Where-Object Type -eq 'NS' |
      ForEach-Object { $_.NameHost.TrimEnd('.').ToLowerInvariant() })
} catch {
  Stop-WithMessage "Cannot query name servers for ${domain}: $($_.Exception.Message)" 2
}

Write-Host ('Current name servers: ' + ($nameServers -join ', '))
if (-not ($nameServers | Where-Object { $_ -match '\.ns\.cloudflare\.com$' })) {
  Stop-WithMessage 'DNS is not on Cloudflare yet. Follow docs\remote-deployment.md and preserve the GitHub Pages records first.' 3
}

try {
  $null = Resolve-DnsName $publicHost -ErrorAction Stop
  Write-Host "[OK] $publicHost resolves." -ForegroundColor Green
} catch {
  Stop-WithMessage "Cannot resolve $publicHost. Add the Cloudflare Tunnel Public Hostname pointing to $originUrl first." 4
}

if (Get-Service cloudflared -ErrorAction SilentlyContinue) {
  Stop-WithMessage 'A cloudflared Windows service already exists; refusing to overwrite its Tunnel credentials.' 5
}

try {
  # Never trust PATH or an unverified existing EXE while running as Administrator.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $cloudflared = Get-VerifiedCloudflared -DownloadIfMissing
  & $cloudflared --version
  if ($LASTEXITCODE -ne 0) { throw "cloudflared exited with code $LASTEXITCODE" }
} catch {
  Stop-WithMessage "Pinned cloudflared $script:CloudflaredVersion failed verification: $($_.Exception.Message)" 5
}

Write-Host ''
Write-Host 'Paste ONLY the connector Token here, never a service-install command.'
Write-Host 'Use right-click or Shift+Insert in this administrator console; do not pass it on a command line.' -ForegroundColor Yellow
Write-Host 'The installer does not write the Token to the project or console log. However cloudflared service install receives it as a child-process argument; the service registration may persist it.' -ForegroundColor Yellow
Write-Host 'Never share the Token through QQ, chat, Git, screenshots or shell history. Rotate it immediately if exposed.' -ForegroundColor Yellow
$secureToken = Read-Host 'Tunnel Token' -AsSecureString
$tokenPtr = [IntPtr]::Zero
$token = $null
$failure = $null
$failureCode = 6
try {
  $tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
  if ([string]::IsNullOrWhiteSpace($token) -or $token -cnotmatch '^[A-Za-z0-9._~+/=-]{80,4096}$') {
    throw 'Enter the bare connector Token only (80-4096 valid characters, no command, quotes or spaces).'
  }
  $failureCode = 7
  Write-Host '[INFO] Installing the cloudflared Windows service...' -ForegroundColor Cyan
  # The upstream CLI has no stdin secret channel. This child process/service may expose the Token
  # in process arguments or service configuration; the script never prints it itself.
  & $cloudflared service install $token
  if ($LASTEXITCODE -ne 0) { throw 'Service installation returned an error; inspect whether a partial service was created before retrying.' }
  $service = Get-Service cloudflared -ErrorAction SilentlyContinue
  if (-not $service) { throw 'cloudflared reported success but no Windows service was created.' }
  if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
    Start-Service $service
    $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(15))
  }
  Write-Host '[OK] cloudflared Windows service is running.' -ForegroundColor Green
} catch {
  # Do not copy exception details from the upstream CLI: they might include the Token.
  $failure = if ($failureCode -eq 6) { 'Invalid connector Token input.' } else { 'Service did not reach RUNNING. Inspect service status locally; do not retry blindly. Rotate Token if it appeared in process logs.' }
} finally {
  $token = $null
  $secureToken = $null
  if ($tokenPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
  }
}
if ($failure) { Stop-WithMessage $failure $failureCode }

try {
  $serviceAcl = Get-Acl 'HKLM:\SYSTEM\CurrentControlSet\Services\cloudflared'
  $readers = @($serviceAcl.Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and
    $_.IdentityReference.Value -match '(?i)(Everyone|Authenticated Users|BUILTIN\Users|所有人|用户)' -and
    (($_.RegistryRights -band [System.Security.AccessControl.RegistryRights]::ReadKey) -ne 0)
  })
  if ($readers.Count -gt 0) {
    Write-Warning 'Service registry ACL permits broad read access. Inspect it locally; cloudflared may persist the connector Token in the service command. Restrict local accounts and rotate exposed Tokens.'
  } else {
    Write-Host '[INFO] No broad service-registry read ACL was detected; confirm your local security policy.'
  }
} catch {
  Write-Warning 'Unable to inspect service registry ACL. Review local service configuration and Token exposure manually.'
}

Write-Host ''
try {
  $local = Invoke-RestMethod -Uri "$originUrl/api/v1/health" -TimeoutSec 5 -UseBasicParsing
  if ($local.ok -ne $true -or $local.data.apiVersion -ne 1) { throw 'Unexpected v1 health response' }
  Write-Host '[OK] Local mobile API is healthy.' -ForegroundColor Green
} catch {
  Write-Host '[PENDING] Local API is unavailable. Start the latest QQ AI Bot and verify again.' -ForegroundColor Yellow
}

try {
  $public = Invoke-RestMethod -Uri "$publicUrl/api/v1/health" -TimeoutSec 15 -UseBasicParsing
  if ($public.ok -ne $true -or $public.data.apiVersion -ne 1) { throw 'Unexpected v1 health response' }
  Write-Host "[OK] Fixed public URL is healthy: $publicUrl" -ForegroundColor Green
} catch {
  Write-Host '[PENDING] Public health check failed. After starting QQ AI Bot, run:' -ForegroundColor Yellow
  Write-Host "  curl.exe $publicUrl/api/v1/health"
}

Write-Host ''
Write-Host 'Final step: save this URL in the QQ AI Bot iPhone secure remote settings:'
Write-Host "  $publicUrl" -ForegroundColor Cyan
Write-Host 'Create a one-time pairing QR code only after the public health check succeeds.'
