' Launch Jarvis with no console window.
' Double-click this, or let the startup entry created by the app call electron.exe directly.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
exe = base & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "electron.exe was not found." & vbCrLf & "Run: npm install", 16, "Jarvis"
  WScript.Quit 1
End If
sh.Run """" & exe & """ """ & base & """", 0, False
