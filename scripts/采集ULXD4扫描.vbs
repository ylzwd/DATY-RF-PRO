Option Explicit
' Visible, interactive evidence tool. No capture begins until Python asks for
' a receiver IP and the user confirms with Enter. Uses only project Python.
Dim fso, shellApp, projectRoot, pythonPath, scriptPath, arguments
Set fso = CreateObject("Scripting.FileSystemObject")
projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
pythonPath = fso.BuildPath(projectRoot, "app\tools\python\python.exe")
scriptPath = fso.BuildPath(projectRoot, "scripts\project-shure-scan-capture.py")
If Not fso.FileExists(pythonPath) Or Not fso.FileExists(scriptPath) Then
    MsgBox "The complete DATY RF PRO project is required. Keep this tool in its scripts folder.", vbExclamation, "DATY RF PRO"
    WScript.Quit 1
End If
arguments = "-X utf8 -B " & Chr(34) & scriptPath & Chr(34) & " --interactive --engine raw-ip --seconds 600"
Set shellApp = CreateObject("Shell.Application")
On Error Resume Next
' IP-layer reception needs administrator rights. UAC cancellation starts nothing.
' Show a console because the operator must read instructions and mark WWB actions.
shellApp.ShellExecute pythonPath, arguments, projectRoot, "runas", 1
If Err.Number <> 0 Then
    MsgBox "The capture console was not opened. Administrator permission may have been cancelled.", vbInformation, "DATY RF PRO"
    WScript.Quit 1
End If
On Error GoTo 0
