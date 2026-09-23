Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DT {
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string w);
    [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);
    [DllImport("user32.dll")] public static extern int SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    public static void Toggle() {
        var p = FindWindow("Progman", "Program Manager");
        var d = FindWindowEx(p, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (d == IntPtr.Zero) {
            var w = IntPtr.Zero;
            do { w = FindWindowEx(IntPtr.Zero, w, "WorkerW", null); d = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null); } while (d == IntPtr.Zero && w != IntPtr.Zero);
        }
        if (d != IntPtr.Zero) SendMessage(d, 0x0111, (IntPtr)0x7402, IntPtr.Zero);
    }
}
"@
[DT]::Toggle()
