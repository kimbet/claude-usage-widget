# Erstellt Startmenue- + Desktop-Verknuepfungen fuer das Claude-Usage-Widget mit
# eigenem Icon UND eigener AppUserModelID (identisch zu main.js:APP_ID). Nur so
# heftet Windows das Widget mit richtigem Icon/Namen an und startet es korrekt neu
# (statt "electron.exe" leer). ASCII-rein halten (PS5.1 BOM-Falle).

$ErrorActionPreference = 'Stop'
$root   = 'C:\repos\claude-usage-widget'
$exe    = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon   = Join-Path $root 'assets\icon.ico'
$appId  = 'com.arnoldruess.claude-usage-widget'
$name   = 'Claude Usage Widget'
$desc   = 'Claude-Abo-Auslastung (5h/7d) — Always-on-top Widget'

if (-not (Test-Path $exe))  { throw "electron.exe fehlt: $exe" }
if (-not (Test-Path $icon)) { throw "icon.ico fehlt: $icon" }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace WSCut {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey { public Guid fmtid; public uint pid;
    public PropertyKey(Guid f, uint p){ fmtid=f; pid=p; } }

  [StructLayout(LayoutKind.Explicit, Size=24)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr p;
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    void GetCount(out uint c);
    void GetAt(uint i, out PropertyKey k);
    void GetValue(ref PropertyKey k, out PropVariant v);
    void SetValue(ref PropertyKey k, ref PropVariant v);
    void Commit();
  }

  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr d, int fl);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int c);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int c);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int c);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetHotkey(out short w);
    void SetHotkey(short w);
    void GetShowCmd(out int i);
    void SetShowCmd(int i);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, int r);
    void Resolve(IntPtr hwnd, int fl);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
  }

  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPersistFile {
    void GetClassID(out Guid c);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string f, int m);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool r);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  public class CShellLink {}

  public static class Maker {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pvar);
    public static void Create(string lnk, string target, string args, string wd, string icon, string desc, string aumid) {
      var link = (IShellLinkW)new CShellLink();
      link.SetPath(target);
      link.SetArguments(args);
      link.SetWorkingDirectory(wd);
      link.SetIconLocation(icon, 0);
      link.SetDescription(desc);
      link.SetShowCmd(1);
      var key = new PropertyKey(new Guid("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}"), 5);
      var pv = new PropVariant();
      pv.vt = 31; // VT_LPWSTR
      pv.p = Marshal.StringToCoTaskMemUni(aumid);
      var store = (IPropertyStore)link;
      store.SetValue(ref key, ref pv);
      store.Commit();
      PropVariantClear(ref pv);
      ((IPersistFile)link).Save(lnk, true);
    }
  }
}
"@

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$desktop   = [Environment]::GetFolderPath('Desktop')
$targets = @(
  (Join-Path $startMenu "$name.lnk"),
  (Join-Path $desktop  "$name.lnk")
)
foreach ($lnk in $targets) {
  $dir = Split-Path $lnk -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if (Test-Path $lnk) { Remove-Item $lnk -Force }
  [WSCut.Maker]::Create($lnk, $exe, "`"$root`"", $root, $icon, $desc, $appId)
  Write-Output "erstellt: $lnk"
}
Write-Output "AppUserModelID: $appId"
