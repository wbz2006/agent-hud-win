# 按需获取 signtool.exe（Windows SDK Signing Tools）。
#
# 为什么需要它：Authenticode 签名要改写 PE 头部的证书表，PowerShell/.NET 没有
# 稳定可靠的公开 API 能做这件事，实践中都用 signtool。
#
# 为什么下载而不是让用户装 SDK：
#   Windows SDK 安装器 1GB+、要选组件、要管理员权限。而 signtool 本体只依赖
#   同目录的几个 DLL，NuGet 上的 Microsoft.Windows.SDK.BuildTools 包（21MB）
#   里就有完整的 x64 目录，解出来就能用。
#
# 产物：tools\signtool\（已在 .gitignore 排除，不进仓库）

param(
  [string]$Dest = (Join-Path $PSScriptRoot "..\tools\signtool")
)

$ErrorActionPreference = "Stop"

$Dest = [System.IO.Path]::GetFullPath($Dest)
$existing = Join-Path $Dest "signtool.exe"
if (Test-Path $existing) {
  Write-Host "signtool 已存在: $existing" -ForegroundColor Green
  exit 0
}

# 先用系统里可能已装的 SDK
foreach ($root in @("$env:ProgramFiles(x86)\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin")) {
  if (Test-Path $root) {
    $hit = Get-ChildItem $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.DirectoryName -match 'x64' } | Select-Object -First 1
    if ($hit) {
      Write-Host "使用已安装的 Windows SDK: $($hit.FullName)" -ForegroundColor Green
      Write-Host "（如需固定版本，删除 tools\signtool 后重跑本脚本会从 NuGet 拉取）"
      exit 0
    }
  }
}

Write-Host "未找到 signtool，从 NuGet 下载 Microsoft.Windows.SDK.BuildTools..." -ForegroundColor Cyan

$tmp = Join-Path $env:TEMP ("sdkbuildtools-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  $zip = Join-Path $tmp "pkg.zip"
  Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.Windows.SDK.BuildTools" `
    -OutFile $zip -UseBasicParsing -TimeoutSec 300
  Write-Host "  下载完成: $([math]::Round((Get-Item $zip).Length/1MB,1)) MB"

  Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp "x") -Force

  $src = Get-ChildItem (Join-Path $tmp "x\bin") -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
  $x64 = Join-Path $src.FullName "x64"
  if (-not (Test-Path (Join-Path $x64 "signtool.exe"))) { throw "包里没找到 x64\signtool.exe" }

  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Copy-Item (Join-Path $x64 "*") $Dest -Recurse -Force

  $size = (Get-ChildItem $Dest -Recurse -File | Measure-Object Length -Sum).Sum
  Write-Host "完成: $Dest （$([math]::Round($size/1MB,1)) MB）" -ForegroundColor Green
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
