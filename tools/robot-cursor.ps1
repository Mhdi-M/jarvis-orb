<#
  robot-cursor.ps1 — replaces the pointer visual while Jarvis is driving.
  A small always-on-top, click-through robot face follows the cursor and blinks.
  It never intercepts clicks (WS_EX_TRANSPARENT) so the desktop stays usable.
  Stops when the stop file appears or on Esc.
#>
param(
  [string]$StopFile = "$env:TEMP\jarvis-operator.stop"
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr i);
}
"@

if (Test-Path $StopFile) { Remove-Item $StopFile -Force -ErrorAction SilentlyContinue }

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Size = New-Object System.Drawing.Size(64, 64)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 12, 16, 28)
$form.TransparencyKey = [System.Drawing.Color]::FromArgb(255, 12, 16, 28)
$form.Add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $tick = [int](([DateTime]::Now.Ticks % 18000000) / 1800000)
  $blink = ($tick -eq 0 -or $tick -eq 1)

  $body = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 26, 34, 56))
  $edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 126, 214, 168)), 1.6
  $g.FillEllipse($body, 8, 10, 40, 40)
  $g.DrawEllipse($edge, 8, 10, 40, 40)

  # antenna
  $g.DrawLine($edge, 28, 10, 28, 2)
  $g.FillEllipse($edge.Brush, 25, 0, 6, 6)

  $eye = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 127, 180, 216))
  if ($blink) {
    $g.FillRectangle($eye, 17, 29, 8, 2)
    $g.FillRectangle($eye, 31, 29, 8, 2)
  } else {
    $g.FillEllipse($eye, 16, 24, 9, 9)
    $g.FillEllipse($eye, 31, 24, 9, 9)
  }
  # mouth
  $mouth = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 168, 156, 240)), 2
  $g.DrawArc($mouth, 20, 34, 16, 10, 0, 180)
  $g.Dispose()
})

# click-through + tool window: the overlay is decoration, never a target
$form.Add_Shown({
  $cp = New-Object System.Windows.Forms.CreateParams
  $cp.ExStyle = $cp.ExStyle -bor 0x20 -bor 0x80000 -bor 0x80
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 33
$timer.Add_Tick({
  $p = [System.Windows.Forms.Cursor]::Position
  $form.Location = New-Object System.Drawing.Point(($p.X + 10), ($p.Y + 10))
  if (Test-Path $StopFile) { $timer.Stop(); $form.Close() }
  $form.Invalidate()
})
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
