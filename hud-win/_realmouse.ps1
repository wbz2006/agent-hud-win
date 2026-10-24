# ASCII-only script (PowerShell 5.1 reads BOM-less .ps1 as ANSI/GBK).
# Drives the REAL OS cursor so the app's hover polling (screen.getCursorScreenPoint)
# behaves exactly like a human drag. Samples the HUD window rect on every step.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File _realmouse.ps1 -Phase top
#   powershell -ExecutionPolicy Bypass -File _realmouse.ps1 -Phase left
param(
  [string]$Phase = 'top',
  [string]$Match = 'build12'
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RM {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$null = [RM]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$LEFTDOWN = 0x02
$LEFTUP = 0x04

function Get-Rect($proc) {
  $r = New-Object RM+RECT
  $null = [RM]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
  return [pscustomobject]@{
    x = $r.Left; y = $r.Top
    w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top)
  }
}

$hud = Get-Process AgentHUD, electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like '*HUD*' } |
  Where-Object { $_.Path -like "*$Match*" } |
  Select-Object -First 1
if (-not $hud) { Write-Output "NO_WINDOW_MATCHING $Match"; exit 1 }

$rc = Get-Rect $hud
Write-Output ("START pid={0} rect={1},{2} {3}x{4}" -f $hud.Id, $rc.x, $rc.y, $rc.w, $rc.h)

if ($Phase -eq 'top') {
  # Grab the capsule at its centre, then walk right in physical pixels.
  $cx = [int]($rc.x + $rc.w / 2)
  $cy = [int]($rc.y + $rc.h / 2)
  $null = [RM]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 500
  $s = Get-Rect $hud
  Write-Output ("T0 hover   {0},{1} {2}x{3}" -f $s.x, $s.y, $s.w, $s.h)

  $null = [RM]::mouse_event($LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 420
  $s = Get-Rect $hud
  Write-Output ("T1 hold    {0},{1} {2}x{3}" -f $s.x, $s.y, $s.w, $s.h)

  for ($i = 1; $i -le 8; $i++) {
    $null = [RM]::SetCursorPos($cx + $i * 30, $cy)
    Start-Sleep -Milliseconds 140
    $s = Get-Rect $hud
    Write-Output ("T2 step{0}  {1},{2} {3}x{4}" -f $i, $s.x, $s.y, $s.w, $s.h)
  }

  $null = [RM]::mouse_event($LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 700
  $s = Get-Rect $hud
  Write-Output ("T3 release {0},{1} {2}x{3}" -f $s.x, $s.y, $s.w, $s.h)
  Start-Sleep -Milliseconds 900
  $s = Get-Rect $hud
  Write-Output ("T4 settle  {0},{1} {2}x{3}" -f $s.x, $s.y, $s.w, $s.h)

  # Move the real cursor far away: hover state must collapse.
  $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $null = [RM]::SetCursorPos([int]($scr.Width / 2), [int]($scr.Height - 40))
  Start-Sleep -Milliseconds 900
  $s = Get-Rect $hud
  Write-Output ("T5 away    {0},{1} {2}x{3}" -f $s.x, $s.y, $s.w, $s.h)
}

if ($Phase -eq 'left') {
  # Capsule docked left/top -> drag it toward the left edge (vertical morph).
  $cx = [int]($rc.x + $rc.w / 2)
  $cy = [int]($rc.y + $rc.h / 2)
  $null = [RM]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 450
  $null = [RM]::mouse_event($LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  for ($i = 1; $i -le 14; $i++) {
    $null = [RM]::SetCursorPos($cx - $i * 40, $cy + $i * 22)
    Start-Sleep -Milliseconds 140
    $s = Get-Rect $hud
    Write-Output ("L step{0}  {1},{2} {3}x{4}" -f $i, $s.x, $s.y, $s.w, $s.h)
  }
  $null = [RM]::mouse_event($LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 900
  $s = Get-Rect $hud
  Write-Output ("L release  {0},{1} {2}x{3}" -f $s.x, $s.y, $s.w, $s.h)
}

Write-Output 'DONE'
