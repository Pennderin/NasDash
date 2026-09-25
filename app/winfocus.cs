// winfocus.exe - tiny long-running helper for NasDash's peek hotkey.
// Built on demand by main.js with the .NET Framework csc (no SDK needed).
// Reads commands on stdin, one per line:
//   get        -> prints the current foreground window handle (decimal)
//   set <hwnd> -> gives that window focus and brings it to the front
using System;
using System.Runtime.InteropServices;

class WinFocus {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    static void Main() {
        string line;
        while ((line = Console.ReadLine()) != null) {
            line = line.Trim();
            try {
                if (line == "get") {
                    Console.WriteLine(GetForegroundWindow().ToInt64());
                } else if (line.StartsWith("set ")) {
                    IntPtr target = new IntPtr(long.Parse(line.Substring(4)));
                    bool ok = false;
                    if (IsWindow(target) && IsWindowVisible(target) && !IsIconic(target)) {
                        // Borrow the current foreground thread's input state so
                        // Windows' foreground lock lets us hand focus back.
                        uint pid;
                        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
                        uint me = GetCurrentThreadId();
                        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
                        BringWindowToTop(target);
                        ok = SetForegroundWindow(target);
                        if (attached) AttachThreadInput(me, fgThread, false);
                    }
                    Console.WriteLine(ok ? "ok" : "fail");
                } else {
                    Console.WriteLine("?");
                }
            } catch { Console.WriteLine("err"); }
            Console.Out.Flush();
        }
    }
}
