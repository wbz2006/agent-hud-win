# 用自签名证书给 AgentHUD.exe 做 Authenticode 签名。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\sign.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\sign.ps1 -Exe "path\to\AgentHUD.exe"
#
# 依赖链（全部可自动获取）：
#   .certs\AgentHUD-Dev.pfx   ← scripts\make-cert.ps1 生成
#   tools\signtool\           ← scripts\get-signtool.ps1 自动下载（本脚本会代跑）

param(
  [string]$Exe = (Join-Path $PSScriptRoot "..\build\AgentHUD-win32-x64\AgentHUD.exe"),
  [string]$Pfx = (Join-Path $PSScriptRoot "..\.certs\AgentHUD-Dev.pfx"),
  [string]$PfxPasswordFile = (Join-Path $PSScriptRoot "..\.certs\AgentHUD-Dev-password.txt"),
  [switch]$NoTimestamp
)

$ErrorActionPreference = "Stop"

$Exe = [System.IO.Path]::GetFullPath($Exe)
$Pfx = [System.IO.Path]::GetFullPath($Pfx)

if (-not (Test-Path $Exe)) { throw "找不到待签名的文件: $Exe（先 npm run pack）" }
if (-not (Test-Path $Pfx)) { throw "找不到证书: $Pfx`n先运行: powershell -ExecutionPolicy Bypass -File scripts\make-cert.ps1" }
if (-not (Test-Path $PfxPasswordFile)) { throw "找不到口令文件: $PfxPasswordFile" }

# --- 确保 signtool 就位 ---
$signtool = Join-Path $PSScriptRoot "..\tools\signtool\signtool.exe"
if (-not (Test-Path $signtool)) {
  Write-Host "signtool 未就位，自动获取..." -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot "get-signtool.ps1")
  # get-signtool 可能落到系统 SDK（返回 0 但 tools 里没有），再判断一次
  if (-not (Test-Path $signtool)) {
    $sdk = Get-ChildItem "$env:ProgramFiles(x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.DirectoryName -match 'x64' } | Select-Object -First 1
    if ($sdk) { $signtool = $sdk.FullName } else { throw "仍未找到 signtool" }
  }
}

$pwd = (Get-Content -Path $PfxPasswordFile -Raw).Trim()
$securePwd = ConvertTo-SecureString -String $pwd -AsPlainText -Force

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
$cert.Import($Pfx, $securePwd, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)

Write-Host ""
Write-Host "签名目标: $Exe"
Write-Host "证书主题: $($cert.Subject)"
Write-Host "证书指纹: $($cert.Thumbprint)"
Write-Host "有效期至: $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host ""

# 用 /f 指定 pfx 文件而不是 /sha1（后者要求证书已装在证书存储里）
$signArgs = @("sign", "/fd", "SHA256", "/f", $Pfx, "/p", $pwd)
if (-not $NoTimestamp) {
  # 时间戳让签名在证书过期后依然有效（对自签名虽意义有限，但保持流程正规）
  $signArgs += @("/tr", "http://timestamp.digicert.com", "/td", "SHA256")
}
$signArgs += $Exe

& $signtool @signArgs
if ($LASTEXITCODE -ne 0) { throw "签名失败，退出码 $LASTEXITCODE" }

Write-Host ""
Write-Host "验证签名..." -ForegroundColor Cyan
& $signtool verify /pa /v $Exe
$verifyCode = $LASTEXITCODE

Write-Host ""
if ($verifyCode -eq 0) {
  Write-Host "签名完成且校验通过。" -ForegroundColor Green
} else {
  Write-Host "签名已写入，但校验未通过（自签名证书未被本机信任时属正常）。" -ForegroundColor Yellow
  Write-Host "要让本机信任，运行：scripts\trust-cert.ps1" -ForegroundColor Yellow
}
