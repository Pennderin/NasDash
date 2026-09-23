# Hides Spotify's window after a dashboard-triggered launch, so it runs in the
# background with no window or taskbar button. Spotify re-shows its window as it
# finishes starting up, so keep watch for ~12s and re-hide whenever it appears.
# Launching Spotify again (Start menu, tray) brings the window back afterwards.
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class SpHide {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline) {
  $pids = @(Get-Process Spotify -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($pids.Count) {
    [SpHide]::EnumWindows({ param($h, $l)
      $p = 0; [void][SpHide]::GetWindowThreadProcessId($h, [ref]$p)
      if ($pids -contains $p -and [SpHide]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 256; [void][SpHide]::GetWindowText($h, $sb, 256)
        if ($sb.Length -gt 0) { [void][SpHide]::ShowWindow($h, 0) }   # SW_HIDE titled top-level windows only
      }
      $true }, [IntPtr]::Zero) | Out-Null
  }
  Start-Sleep -Milliseconds 300
}
