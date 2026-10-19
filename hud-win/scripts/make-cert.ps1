# 生成自签名代码签名证书（CodeSigning EKU + 私钥导出）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\make-cert.ps1
#
# 产物（默认写到 .certs\，已在 .gitignore 里排除，不会被提交）：
#   .certs\AgentHUD-Dev.pfx        带私钥的证书（签名时用）
#   .certs\AgentHUD-Dev.cer        仅公钥（给别人装"受信任的根证书"时用）
#   .certs\AgentHUD-Dev-password.txt  pfx 口令
#
# 为什么用自签名而不是普通自建证书：
#   signtool/Authenticode 只认带"代码签名"扩展密钥用法（EKU 1.3.6.1.5.5.7.3.3）
#   的证书。普通 SSL/自定义证书会被拒绝签名。
#
# 重要局限（必须知道）：
#   自签名证书不被 Windows 全局信任。别人下载你的程序，SmartScreen 照样会拦。
#   只有当证书被手工导入到对方"受信任的根证书颁发机构"后，签名才被认作有效。
#   它适合：团队内部发布、自己多台电脑、企业域环境分发。
#   它不适合：面向陌生用户的公开下载（那种场景需要 OV/EV 或 Azure Trusted Signing）。

param(
  [string]$Subject = "CN=Agent HUD Dev, O=agent-hud-win, C=CN",
  [int]$Years = 3,
  [string]$OutDir = (Join-Path $PSScriptRoot "..\.certs")
)

$ErrorActionPreference = "Stop"

$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$pfxPath = Join-Path $OutDir "AgentHUD-Dev.pfx"
$cerPath = Join-Path $OutDir "AgentHUD-Dev.cer"
$pwdPath = Join-Path $OutDir "AgentHUD-Dev-password.txt"

# 已存在就不覆盖：证书一旦换了，之前签名过的旧版本就不再匹配
if (Test-Path $pfxPath) {
  Write-Host "证书已存在，跳过生成：$pfxPath" -ForegroundColor Yellow
  Write-Host "如需重新生成，请先删除 .certs 目录（注意：旧签名的程序将不再与其匹配）"
  exit 0
}

Write-Host "生成自签名代码签名证书..." -ForegroundColor Cyan
Write-Host "  主题: $Subject"
Write-Host "  有效期: $Years 年"

$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature -NotAfter (Get-Date).AddYears($Years) -CertStoreLocation "Cert:\CurrentUser\My"

# 口令落盘到同目录（该目录已被 .gitignore 排除）。自签名场景下口令只是避免
# pfx 裸奔，不承担真正的安全边界 —— 真要防泄漏就别把 .certs 拷给别人。
$password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$securePwd = ConvertTo-SecureString -String $password -AsPlainText -Force

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePwd | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Set-Content -Path $pwdPath -Value $password -Encoding ascii

Write-Host ""
Write-Host "完成：" -ForegroundColor Green
Write-Host "  PFX（签名用）: $pfxPath"
Write-Host "  CER（公钥）  : $cerPath"
Write-Host "  口令文件     : $pwdPath"
Write-Host ""
Write-Host "指纹（Thumbprint）: $($cert.Thumbprint)"
Write-Host ""
Write-Host "下一步：powershell -ExecutionPolicy Bypass -File scripts\sign.ps1" -ForegroundColor Cyan
