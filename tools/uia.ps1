<#
  uia.ps1 - UI Automation access to a real window, so an agent can say
  "click Send" instead of guessing pixels.

  Actions (all print JSON):
    -Action list    -Window "<title match>" [ -Max 200 ]
    -Action invoke  -Window "<title match>" -Name "<element name or regex>"
    -Action set     -Window "<title match>" -Name "<element name>" -Value "text"
    -Action focus   -Window "<title match>"

  Elements are reported with name, control type, automation id, bounds and
  whether they are enabled, which is what a locator needs to choose between
  "the Send button" and "the Send label next to it".
#>
param(
  [ValidateSet('list','invoke','set','focus')]
  [string]$Action = 'list',
  [string]$Window = '',
  [string]$Name = '',
  [string]$Value = '',
  [int]$Max = 200
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Get-Window([string]$match) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $kids = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($k in $kids) {
    $t = $k.Current.Name
    if ($t -and ($t -match [regex]::Escape($match) -or $t -like "*$match*")) { return $k }
  }
  return $null
}

$win = Get-Window $Window
if (-not $win) { Write-Output (@{ ok = $false; error = "no window matching '$Window'" } | ConvertTo-Json -Compress); exit 1 }

if ($Action -eq 'focus') {
  try { $win.SetFocus(); Write-Output (@{ ok = $true; window = $win.Current.Name } | ConvertTo-Json -Compress) }
  catch { Write-Output (@{ ok = $false; error = "$_" } | ConvertTo-Json -Compress) }
  exit 0
}

$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
$els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)

if ($Action -eq 'list') {
  $out = @()
  $n = 0
  foreach ($e in $els) {
    if ($n -ge $Max) { break }
    try {
      $c = $e.Current
      if (-not $c.Name -and -not $c.AutomationId) { continue }
      $r = $c.BoundingRectangle
      $out += [pscustomobject]@{
        name    = $c.Name
        type    = $c.ControlType.ProgrammaticName -replace 'ControlType\.',''
        id      = $c.AutomationId
        x       = [int]$r.X
        y       = [int]$r.Y
        w       = [int]$r.Width
        h       = [int]$r.Height
        enabled = $c.IsEnabled
      }
      $n++
    } catch {}
  }
  Write-Output (@{ ok = $true; window = $win.Current.Name; count = $out.Count; elements = $out } | ConvertTo-Json -Compress -Depth 4)
  exit 0
}

# invoke / set: first element whose name matches, preferring an actionable type
$target = $null
foreach ($e in $els) {
  try {
    if ($e.Current.Name -and $e.Current.Name -match $Name) { $target = $e; break }
  } catch {}
}
if (-not $target) { Write-Output (@{ ok = $false; error = "no element matching '$Name'" } | ConvertTo-Json -Compress); exit 1 }

if ($Action -eq 'invoke') {
  $pat = $null
  if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
    $pat.Invoke()
    Write-Output (@{ ok = $true; via = 'invoke'; element = $target.Current.Name } | ConvertTo-Json -Compress)
    exit 0
  }
  $r = $target.Current.BoundingRectangle
  Write-Output (@{ ok = $false; via = 'bounds'; element = $target.Current.Name;
    x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2);
    note = 'no InvokePattern; click these coordinates' } | ConvertTo-Json -Compress)
  exit 0
}

if ($Action -eq 'set') {
  $pat = $null
  if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
    $pat.SetValue($Value)
    Write-Output (@{ ok = $true; via = 'value'; element = $target.Current.Name } | ConvertTo-Json -Compress)
    exit 0
  }
  $r = $target.Current.BoundingRectangle
  Write-Output (@{ ok = $false; via = 'focus'; element = $target.Current.Name;
    x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2);
    note = 'no ValuePattern; focus the element and paste text' } | ConvertTo-Json -Compress)
}
