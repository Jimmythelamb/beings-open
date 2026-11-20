' Stop-BEINGS-Helper.vbs
' Stops the hidden helper on this PC. No console window.
Option Explicit

Dim fso, dir, svc, procs, proc, cmd, f
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

On Error Resume Next
Set svc = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number = 0 Then
  Set procs = svc.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
  For Each proc In procs
    cmd = "" & proc.CommandLine
    If InStr(1, cmd, "cli.mjs", vbTextCompare) > 0 And InStr(1, cmd, "bridge", vbTextCompare) > 0 Then
      proc.Terminate
    End If
  Next
End If
Err.Clear
Set f = fso.OpenTextFile(dir & "\helper.log", 8, True)
f.WriteLine Now & " stop requested"
f.Close
On Error GoTo 0
