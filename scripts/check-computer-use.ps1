param([string]$ToolRoot = '<å·¥å·ç®å½>\computer-use')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$win = Join-Path $ToolRoot 'win'
foreach($name in @('capture.cs','input.cs','input2.cs','keys.cs','mark.cs')) {
 Add-Type -Path (Join-Path $win $name) -ReferencedAssemblies @('System.Drawing')
 Write-Output ('COMPILE_OK ' + $name)
}
foreach($f in Get-ChildItem $win -Filter '*.ps1') {
 $tokens=$null; $errors=$null
 $null=[System.Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$tokens,[ref]$errors)
 if($errors.Count -gt 0){ throw ('Script parse failed: '+$f.Name) }
 Write-Output ('PARSE_OK ' + $f.Name)
}
$dir=Join-Path $PSScriptRoot '../artifacts/computer-use'
$null=New-Item -ItemType Directory -Force -Path $dir
$src=Join-Path $dir 'synthetic.png';$dst=Join-Path $dir 'synthetic-marked.png'
$bmp=New-Object System.Drawing.Bitmap(160,100)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$bmp.Save($src,[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose()
$before=(Get-FileHash $src -Algorithm SHA256).Hash
$result=[WinMark]::Mark($src,$dst,'80:50',20,'')
if($result.StartsWith('ERR')){throw $result}
if(-not(Test-Path $dst)){throw 'Marked image not created'}
if((Get-FileHash $src -Algorithm SHA256).Hash -ne $before){throw 'Source image modified'}
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$ocr=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
Write-Output ('OCR_ENGINE_AVAILABLE ' + ($null -ne $ocr))
Write-Output 'MARK_OK source unchanged; synthetic image only'
Write-Output 'CHECK_OK no screen capture, clicking, typing or clipboard changes performed'
