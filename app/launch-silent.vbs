Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\NasDashHomepage")
WshShell.Run """" & WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\NasDashHomepage\node_modules\electron\dist\electron.exe") & """ .", 0, False
