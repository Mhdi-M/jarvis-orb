<#
  robot-cursor.ps1 — replaces the pointer visual while Jarvis is driving.
  A small always-on-top, click-through robot face follows the cursor and blinks.
  It never intercepts clicks (WS_EX_TRANSPARENT) so the desktop stays usable.
  Stops when the stop file appears or on Esc.
#>
param(
  [string]$StopFile = "$env:TEMP\jarvis-operator.stop",
  [int]$Scale = 4
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

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Windows.Forms;
public class OverlayForm : Form {
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x20;      // WS_EX_TRANSPARENT - clicks pass through
      // no WS_EX_LAYERED: combined with TransparencyKey it cancels the window
      cp.ExStyle |= 0x80;      // WS_EX_TOOLWINDOW - no taskbar entry
      return cp;
    }
  }
}
"@
$form = New-Object OverlayForm
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Size = New-Object System.Drawing.Size((8 * $Scale + 2), (8 * $Scale + 2))
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 12, 16, 28)
# TransparencyKey removed: with a themed BackColor it blanked the whole window

# palette matches Jarvis; $scale keeps the pixels square
$scale = $Scale
$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 126, 214, 168))
$eye = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 127, 180, 216))
$ant = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 240, 198, 116))
$LOG = "$env:TEMP\robot-paint.log"
function Note([string]$m) { try { Add-Content -Path $LOG -Value ((Get-Date -Format 'HH:mm:ss.fff') + ' ' + $m) } catch {} }
Note ('start pid=' + $PID + ' scale=' + $Scale)

$paints = 0
$form.Add_Paint({
  param($s, $e)
  $script:paints++
  if ($script:paints -le 3 -or $script:paints % 100 -eq 0) {
    Note ('paint #' + $script:paints + ' @ ' + $form.Location.X + ',' + $form.Location.Y + ' visible=' + $form.Visible + ' opacity=' + $form.Opacity)
  }
  $g = $e.Graphics
  $g.InterpolationMode = 'NearestNeighbor'
  # 8x8 pixel robot, two frames: antenna bob + blink. 0 empty, 1 ink, 2 eye, 3 antenna
  $f0 = @(
    "00030000",
    "00111100",
    "01222110",
    "01222110",
    "01111110",
    "00111100",
    "01100110",
    "01000010"
  )
  $f1 = @(
    "00000000",
    "00030000",
    "00111100",
    "01222110",
    "01111110",
    "00111100",
    "01100110",
    "01000010"
  )
  $f = 0
  if ((([int](([DateTime]::Now.Ticks % 8000000) / 4000000)) % 2) -eq 1) { $f = 1 }
  $frame = if ($f -eq 0) { $f0 } else { $f1 }
  for ($y = 0; $y -lt 8; $y++) {
    $row = $frame[$y]
    for ($x = 0; $x -lt 8; $x++) {
      $c = $row.Substring($x, 1)
      if ($c -eq '0') { continue }
      $b = switch ($c) { '1' { $ink } '2' { $eye } '3' { $ant } }
      $g.FillRectangle($b, ($x * $scale), ($y * $scale), $scale, $scale)
    }
  }
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
