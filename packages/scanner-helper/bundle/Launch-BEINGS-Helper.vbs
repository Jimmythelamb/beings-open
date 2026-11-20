' Launch-BEINGS-Helper.vbs
' Starts the BEINGS scanner helper with no console window.
' A Start menu shortcut, the sign-in entry, and beings-helper://start all use this file.
' The only accepted link is beings-helper://start. Other arguments are ignored.
Option Explicit

Dim sh, fso, dir, arg, nodeExe, scans, cmd, stream
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count > 0 Then
  arg = LCase(Trim(CStr(WScript.Arguments(0))))
  If Left(arg, 15) = "beings-helper:" Then
    If InStr(1, arg, "start", vbTextCompare) = 0 Then WScript.Quit 0
  Else
    WScript.Quit 0
  End If
End If

nodeExe = dir & "\node\node.exe"
If Not fso.FileExists(nodeExe) Then
  If fso.FileExists(dir & "\node-path.txt") Then
    Set stream = fso.OpenTextFile(dir & "\node-path.txt", 1, False)
    nodeExe = Trim(stream.ReadLine)
    stream.Close
  End If
End If

If nodeExe = "" Or Not fso.FileExists(nodeExe) Then
  AppendLog dir, "node.exe was not found. Run the setup file again."
  WScript.Quit 1
End If

scans = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\Documents\BEINGS-Scans"
If Not fso.FolderExists(scans) Then
  On Error Resume Next
  fso.CreateFolder scans
  On Error GoTo 0
End If

AppendLog dir, "starting helper"
sh.Environment("PROCESS")("BEINGS_HELPER_LOG") = dir & "\helper.log"
sh.CurrentDirectory = dir
cmd = """" & nodeExe & """ """ & dir & "\src\cli.mjs"" bridge --output-root """ & scans & """"
' Window style 0 is hidden. False means do not wait.
sh.Run cmd, 0, False

Sub AppendLog(folder, text)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(folder & "\helper.log", 8, True)
  f.WriteLine Now & " " & text
  f.Close
  On Error GoTo 0
End Sub
