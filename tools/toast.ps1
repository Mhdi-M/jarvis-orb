param([string]$Title = "Jarvis", [string]$Message = "done")
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(6000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 7
$n.Dispose()
