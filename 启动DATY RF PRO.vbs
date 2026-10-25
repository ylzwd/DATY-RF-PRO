Option Explicit
' The project host waits for the native window and gracefully stops its own backend.
' Closing the last project window completes the same start/stop lifecycle.
Dim fso, shell, root, command
Set fso=CreateObject("Scripting.FileSystemObject")
Set shell=CreateObject("WScript.Shell")
root=fso.GetParentFolderName(WScript.ScriptFullName)
command=Chr(34) & root & "\app\tools\python\pythonw.exe" & Chr(34) & " -X utf8 -B " & Chr(34) & root & "\scripts\project-local.py" & Chr(34) & " launch"
shell.Run command,0,False
