# Pin an upstream release and verify the official asset before any elevated execution.
# Asset + SHA256 independently checked against Cloudflare's GitHub release 2026.9.1.
$script:CloudflaredVersion = '2026.9.1'
$script:CloudflaredSha256 = '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712'
$script:CloudflaredDownloadUrl = "https://github.com/cloudflare/cloudflared/releases/download/$script:CloudflaredVersion/cloudflared-windows-amd64.exe"

function Assert-CloudflaredHash {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$ExpectedSha256)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'cloudflared.exe is missing.' }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a linked cloudflared.exe.' }
  if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid pinned SHA256.' }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  if ($actual -ine $ExpectedSha256) { throw 'cloudflared.exe SHA256 mismatch. Refusing to execute or replace it.' }
  return $true
}

function Get-VerifiedCloudflared {
  [CmdletBinding()]
  param([switch]$DownloadIfMissing,
        [string]$InstallDirectory = (Join-Path $env:ProgramFiles 'cloudflared'),
        [string]$ExpectedSha256 = $script:CloudflaredSha256,
        [string]$DownloadUrl = $script:CloudflaredDownloadUrl,
        [scriptblock]$DownloadAction = {
          param($url, $destination)
          Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destination
        })
  if (Test-Path -LiteralPath $InstallDirectory) {
    $dir = Get-Item -LiteralPath $InstallDirectory -Force
    if (-not $dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing a linked or invalid cloudflared installation directory.'
    }
  } else {
    if (-not $DownloadIfMissing) { throw 'cloudflared installation directory is missing.' }
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
  }
  $exe = Join-Path $InstallDirectory 'cloudflared.exe'
  if (Test-Path -LiteralPath $exe) {
    $null = Assert-CloudflaredHash -Path $exe -ExpectedSha256 $ExpectedSha256
    return $exe
  }
  if (-not $DownloadIfMissing) { throw 'cloudflared.exe is missing; reinstall from a trusted source.' }
  $temp = Join-Path $InstallDirectory ("cloudflared.$([Guid]::NewGuid().ToString('N')).download")
  try {
    & $DownloadAction $DownloadUrl $temp
    $null = Assert-CloudflaredHash -Path $temp -ExpectedSha256 $ExpectedSha256
    Move-Item -LiteralPath $temp -Destination $exe -ErrorAction Stop
    $null = Assert-CloudflaredHash -Path $exe -ExpectedSha256 $ExpectedSha256
    return $exe
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}
