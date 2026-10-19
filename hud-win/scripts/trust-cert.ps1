# 把自签名证书导入"受信任的根证书颁发机构"，让本机认可签名。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\trust-cert.ps1            # 当前用户（无需管理员）
#   powershell -ExecutionPolicy Bypass -File scripts\trust-cert.ps1 -Machine   # 本机所有用户（需管理员）
#
# ⚠️ 安全提醒：
#   把证书装进"受信任的根证书颁发机构"= 授权这张证书签发的任何程序在本机运行。
#   只应导入你自己生成的证书。别人给你的 .cer 不要随便装。
#
# 卸载：
#   当前用户 → certmgr.msc → 受信任的根证书颁发机构 → 证书 → 找到 "Agent HUD Dev" 删除

param(
  [string]$Cer = (Join-Path $PSScriptRoot "..\.certs\AgentHUD-Dev.cer"),
  [switch]$Machine,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$Cer = [System.IO.Path]::GetFullPath($Cer)
$storeName = "Root"          # 受信任的根证书颁发机构
$storeLoc = if ($Machine) { "LocalMachine" } else { "CurrentUser" }

if ($Remove) {
  Write-Host "从 $storeLoc\$storeName 移除 Agent HUD Dev 证书..." -ForegroundColor Cyan
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, $storeLoc)
  $store.Open("ReadWrite")
  $targets = $store.Certificates | Where-Object { $_.Subject -like "*Agent HUD Dev*" }
  foreach ($c in $targets) {
    $store.Remove($c)
    Write-Host "  已移除: $($c.Subject) [$($c.Thumbprint)]"
  }
  $store.Close()
  Write-Host "完成。" -ForegroundColor Green
  exit 0
}

if (-not (Test-Path $Cer)) { throw "找不到证书: $Cer（先运行 scripts\make-cert.ps1）" }

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Cer)
Write-Host "准备信任：" -ForegroundColor Cyan
Write-Host "  主题: $($cert.Subject)"
Write-Host "  指纹: $($cert.Thumbprint)"
Write-Host "  位置: $storeLoc\$storeName"
Write-Host ""
Write-Host "这会授权该证书签发的程序在本机运行。确认是你自己生成的证书再继续。" -ForegroundColor Yellow

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, $storeLoc)
$store.Open("ReadWrite")
$store.Add($cert)
$store.Close()

Write-Host ""
Write-Host "已导入受信任根。" -ForegroundColor Green
Write-Host "现在运行 scripts\sign.ps1 重新签名后，signtool verify /pa 应当通过。" -ForegroundColor Green
