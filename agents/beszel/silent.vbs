' Beszel agent (PC) - starts hidden at login and reports to the Beszel hub on the NAS.
' Connection settings (KEY, TOKEN, HUB_URL, SYSTEM_NAME) live in agent.env next to this
' file, so nothing secret is in the launcher. install.ps1 restores agent.env and the
' data\fingerprint identity file from the NAS kit's private folder.
' The local listener is bound to loopback: the agent only connects OUT to the hub.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\BeszelAgent")
Set env = sh.Environment("Process")
If fso.FileExists(dir & "\agent.env") Then
  Set f = fso.OpenTextFile(dir & "\agent.env", 1)
  Do Until f.AtEndOfStream
    line = Trim(f.ReadLine)
    p = InStr(line, "=")
    If p > 1 And Left(line, 1) <> "#" Then env(Left(line, p - 1)) = Mid(line, p + 1)
  Loop
  f.Close
End If
env("LISTEN") = "127.0.0.1:45876"
env("DATA_DIR") = dir & "\data"
sh.CurrentDirectory = dir
sh.Run """" & dir & "\beszel-agent.exe""", 0, False
