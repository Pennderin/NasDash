' Silent launcher for Steam Agent - no console window
Set objShell = WScript.CreateObject("WScript.Shell")
objShell.Run """" & objShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\SteamAgent\run.bat") & """", 0, False
