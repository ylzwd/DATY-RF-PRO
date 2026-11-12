Option Explicit
' Use the same native startup animation and owned lifecycle as the desktop icon.
Dim fso, shell, root, command
Set fso=CreateObject("Scripting.FileSystemObject")
Set shell=CreateObject("WScript.Shell")
root=fso.GetParentFolderName(WScript.ScriptFullName)
command=Chr(34) & root & "\DATY RF PRO.exe" & Chr(34)
shell.Run command,1,False
