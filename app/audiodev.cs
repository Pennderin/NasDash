// audiodev.exe — tiny Windows audio endpoint helper for NasDash's Coms card.
// Built locally with the .NET Framework compiler (no downloads).
//   audiodev list                          -> JSON: endpoints + current defaults
//   audiodev set-default <id> [all|console|comms]
//   audiodev hide <id> | show <id>         -> endpoint visibility (may need admin)
//   audiodev watch                         -> prints a line on every device/default change
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace NasDashAudio {
  enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow flow, int mask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(EDataFlow flow, ERole role, out IMMDevice device);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IMMNotificationClient client);
    int UnregisterEndpointNotificationCallback(IMMNotificationClient client);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { int GetCount(out int n); int Item(int i, out IMMDevice d); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { int GetCount(out int n); int GetAt(int i, out PROPERTYKEY k); int GetValue(ref PROPERTYKEY k, out PROPVARIANT v); }
  [ComImport, Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMNotificationClient {
    void OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, int state);
    void OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
    void OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
    void OnDefaultDeviceChanged(EDataFlow flow, ERole role, [MarshalAs(UnmanagedType.LPWStr)] string id);
    void OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PROPERTYKEY key);
  }
  // Undocumented but stable since Vista: used by every "switch default device" tool.
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    int GetMixFormat(); int GetDeviceFormat(); int ResetDeviceFormat(); int SetDeviceFormat();
    int GetProcessingPeriod(); int SetProcessingPeriod(); int GetShareMode(); int SetShareMode();
    int GetPropertyValue(); int SetPropertyValue();
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, ERole role);
    int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
  }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out int n);
    int SetMasterVolumeLevel(float db, ref Guid ctx); int SetMasterVolumeLevelScalar(float v, ref Guid ctx);
    int GetMasterVolumeLevel(out float db); int GetMasterVolumeLevelScalar(out float v);
    int SetChannelVolumeLevel(int ch, float db, ref Guid ctx); int SetChannelVolumeLevelScalar(int ch, float v, ref Guid ctx);
    int GetChannelVolumeLevel(int ch, out float db); int GetChannelVolumeLevelScalar(int ch, out float v);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo { }
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigCo { }

  class Watcher : IMMNotificationClient {
    void Emit(string s) { Console.WriteLine(s); Console.Out.Flush(); }
    public void OnDeviceStateChanged(string id, int state) { Emit("state\t" + id + "\t" + state); }
    public void OnDeviceAdded(string id) { Emit("added\t" + id); }
    public void OnDeviceRemoved(string id) { Emit("removed\t" + id); }
    public void OnDefaultDeviceChanged(EDataFlow f, ERole r, string id) { Emit("default\t" + (int)f + "\t" + (int)r + "\t" + (id ?? "")); }
    public void OnPropertyValueChanged(string id, PROPERTYKEY k) { }
  }

  static class Program {
    static PROPERTYKEY PKEY_FriendlyName = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }
    static string Name(IMMDevice d) {
      IPropertyStore ps; if (d.OpenPropertyStore(0, out ps) != 0) return "";
      PROPVARIANT v; var k = PKEY_FriendlyName;
      if (ps.GetValue(ref k, out v) != 0 || v.vt != 31) return "";
      return Marshal.PtrToStringUni(v.p);
    }
    static string DefId(IMMDeviceEnumerator e, EDataFlow f, ERole r) { IMMDevice d; if (e.GetDefaultAudioEndpoint(f, r, out d) != 0) return ""; string id; d.GetId(out id); return id; }

    static int Main(string[] a) {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
      string cmd = a.Length > 0 ? a[0] : "list";
      if (cmd == "list") {
        var sb = new StringBuilder("{\"endpoints\":[");
        bool first = true;
        foreach (var flow in new[] { EDataFlow.eRender, EDataFlow.eCapture }) {
          IMMDeviceCollection col; en.EnumAudioEndpoints(flow, 0x1 | 0x2 | 0x4 | 0x8, out col);  // active, disabled, not present, unplugged
          int n; col.GetCount(out n);
          for (int i = 0; i < n; i++) {
            IMMDevice d; col.Item(i, out d); string id; d.GetId(out id); int st; d.GetState(out st);
            if (st == 4) continue; // not present
            if (!first) sb.Append(","); first = false;
            sb.Append("{\"id\":\"" + Esc(id) + "\",\"name\":\"" + Esc(Name(d)) + "\",\"flow\":\"" + (flow == EDataFlow.eRender ? "render" : "capture") + "\",\"state\":" + st + "}");
          }
        }
        sb.Append("],\"defaults\":{");
        sb.Append("\"render\":\"" + Esc(DefId(en, EDataFlow.eRender, ERole.eConsole)) + "\",");
        sb.Append("\"renderComms\":\"" + Esc(DefId(en, EDataFlow.eRender, ERole.eCommunications)) + "\",");
        sb.Append("\"capture\":\"" + Esc(DefId(en, EDataFlow.eCapture, ERole.eConsole)) + "\",");
        sb.Append("\"captureComms\":\"" + Esc(DefId(en, EDataFlow.eCapture, ERole.eCommunications)) + "\"}}");
        Console.WriteLine(sb.ToString());
        return 0;
      }
      if ((cmd == "vol" || cmd == "setvol" || cmd == "mute") && a.Length >= 2) {
        IMMDevice d; if (en.GetDevice(a[1], out d) != 0) { Console.WriteLine("error no-device"); return 1; }
        var iid = typeof(IAudioEndpointVolume).GUID; object o;
        if (d.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o) != 0) { Console.WriteLine("error activate"); return 1; }
        var ev = (IAudioEndpointVolume)o; var ctx = Guid.Empty;
        if (cmd == "setvol" && a.Length >= 3) ev.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, float.Parse(a[2], System.Globalization.CultureInfo.InvariantCulture) / 100f)), ref ctx);
        if (cmd == "mute" && a.Length >= 3) ev.SetMute(a[2] == "1", ref ctx);
        float v; bool m; ev.GetMasterVolumeLevelScalar(out v); ev.GetMute(out m);
        Console.WriteLine("{\"volume\":" + Math.Round(v * 100) + ",\"muted\":" + (m ? "true" : "false") + "}");
        return 0;
      }
      var pc = (IPolicyConfig)new PolicyConfigCo();
      if (cmd == "set-default" && a.Length >= 2) {
        string which = a.Length >= 3 ? a[2] : "all"; int hr = 0;
        if (which == "all" || which == "console") { hr |= pc.SetDefaultEndpoint(a[1], ERole.eConsole); hr |= pc.SetDefaultEndpoint(a[1], ERole.eMultimedia); }
        if (which == "all" || which == "comms") hr |= pc.SetDefaultEndpoint(a[1], ERole.eCommunications);
        Console.WriteLine(hr == 0 ? "ok" : "error 0x" + hr.ToString("X")); return hr == 0 ? 0 : 1;
      }
      if ((cmd == "hide" || cmd == "show") && a.Length >= 2) {
        int hr = pc.SetEndpointVisibility(a[1], cmd == "show" ? 1 : 0);
        Console.WriteLine(hr == 0 ? "ok" : "error 0x" + hr.ToString("X")); return hr == 0 ? 0 : 1;
      }
      if (cmd == "watch") {
        var w = new Watcher(); en.RegisterEndpointNotificationCallback(w);
        new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();  // parent gone -> exit
        Console.WriteLine("watching"); Console.Out.Flush();
        Thread.Sleep(Timeout.Infinite); return 0;
      }
      Console.WriteLine("usage: audiodev list | set-default <id> [all|console|comms] | hide <id> | show <id> | watch");
      return 2;
    }
  }
}
