# 用自签名证书给 AgentHUD.exe 做 Authenticode 签名。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\sign.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\sign.ps1 -Exe "path\to\AgentHUD.exe"
#
# 依赖链（全部可自动获取）：
#   .certs\AgentHUD-Dev.pfx   ← scripts\make-cert.ps1 生成
#   tools\signtool\           ← scripts\get-signtool.ps1 自动下载（本脚本会代跑）
#
# 签名方式的兜底顺序（2026-10-24）：
#   ① /f <pfx> —— 原方案
#   ② /sha1 <指纹> —— **实测这台机器上 ① 必然失败**：pfx 里的证书已经装在
#      证书库里，signtool 再 Import 会报 `Store::ImportCertObject() failed`
#      (0x80090010 / NTE_EXISTS)。证书库里的私钥是可用的，直接用指纹签即可。
#   ③ /sha1 <指纹> 且不带 /tr —— GitHub 时间戳服务器在本机常被墙，
#      带时间戳会失败；自签名的时间戳意义本就有限，去掉也能签出 Valid。
#   三步都失败才真正报错，避免"打包成功但签名全红"的噪音。

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

# --- 证书：pfx（可能因"证书已在库里"导入失败）或证书库里已安装的同主题证书 ---
$pfxPassword = $null
$hasPfx = (Test-Path $Pfx) -and (Test-Path $PfxPasswordFile)
if ($hasPfx) {
  $pfxPassword = (Get-Content -Path $PfxPasswordFile -Raw).Trim()
}

$cert = $null
$thumbprint = $null
if ($hasPfx) {
  try {
    $securePwd = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
    $cert.Import($Pfx, $securePwd, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)
    $thumbprint = $cert.Thumbprint
  } catch {
    Write-Warning "导入 pfx 失败（$($_.Exception.Message)），改用证书库里的同主题证书"
  }
}
if (-not $thumbprint) {
  $installed = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like '*Agent HUD Dev*' -and $_.HasPrivateKey } |
    Select-Object -First 1
  if ($installed) {
    $cert = $installed
    $thumbprint = $installed.Thumbprint
  }
}
if (-not $hasPfx -and -not $thumbprint) {
  throw "既没有 pfx（$Pfx），证书库里也没有 'CN=Agent HUD Dev' 的私钥证书`n先运行: powershell -ExecutionPolicy Bypass -File scripts\make-cert.ps1"
}

Write-Host ""
Write-Host "签名目标: $Exe"
if ($cert) {
  Write-Host "证书主题: $($cert.Subject)"
  Write-Host "证书指纹: $thumbprint"
  if ($cert.NotAfter) { Write-Host "有效期至: $($cert.NotAfter.ToString('yyyy-MM-dd'))" }
}
Write-Host ""

function Invoke-Sign([string[]]$extra) {
  $argsList = @("sign", "/fd", "SHA256") + $extra + $Exe
  & $signtool @argsList | Out-Host
  return $LASTEXITCODE
}

$tsArgs = @("/tr", "http://timestamp.digicert.com", "/td", "SHA256")

$code = -1
if ($hasPfx) {
  # ① pfx 直接签名
  $code = Invoke-Sign (@("/f", $Pfx, "/p", $pfxPassword) + $(if ($NoTimestamp) { @() } else { $tsArgs }))
}
if ($code -ne 0 -and $thumbprint) {
  Write-Warning "pfx 签名失败（退出码 $code），改用证书库指纹签名: $thumbprint"
  # ② 证书库指纹 + 时间戳
  $code = Invoke-Sign (@("/sha1", $thumbprint) + $(if ($NoTimestamp) { @() } else { $tsArgs }))
}
if ($code -ne 0 -and $thumbprint) {
  Write-Warning "带时间戳仍失败（退出码 $code）；去掉 /tr 再试（时间戳服务器常不可达）"
  # ③ 证书库指纹，不带时间戳
  $code = Invoke-Sign @("/sha1", $thumbprint)
}
if ($code -ne 0) { throw "签名失败，退出码 $code（三种方式都试过了）" }

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
