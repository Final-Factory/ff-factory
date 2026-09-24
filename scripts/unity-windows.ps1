# List the visible top-level windows of some processes (and of the processes they started), with the
# text and buttons inside each, as JSON. The server's Unity watchdog uses it to see an editor stuck on
# a modal dialog. With -Click it presses one button in one of those windows instead (auto-dismiss).
#   unity-windows.ps1 -Pids 1234,5678
#   unity-windows.ps1 -Pids 1234 -Hwnd 2885298 -Click 'Ignore'
# Read-only unless -Click is given, and -Click only touches a window owned by one of -Pids.
# Unity's dialogs are plain Win32 dialogs (class #32770): the message is a read-only Edit control, which
# GetWindowText cannot read across processes, so text is fetched with WM_GETTEXT. UI Automation reports
# those buttons as panes, so it is only a fallback for windows with no Win32 children (task dialogs).
param(
  # Comma-separated (powershell -File passes a list as one string).
  [Parameter(Mandatory = $true)][string]$Pids,
  [long]$Hwnd = 0,
  [string]$Click = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FfsbWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string TitleOf(IntPtr h) { var s = new StringBuilder(1024); GetWindowText(h, s, 1024); return s.ToString(); }
  /// WM_GETTEXT with a timeout (SMTO_ABORTIFHUNG): works for controls of other processes, never hangs on a stuck one.
  public static string TextOf(IntPtr h) {
    var s = new StringBuilder(8192); IntPtr r;
    SendMessageTimeout(h, 0x000D, (IntPtr)8192, s, 0x0002, 1000, out r);
    return s.ToString();
  }
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static List<IntPtr> TopLevel(HashSet<uint> pids) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { if (IsWindowVisible(h) && pids.Contains(PidOf(h))) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Children(IntPtr p) {
    var list = new List<IntPtr>();
    EnumChildWindows(p, (h, l) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  /// BM_CLICK, posted so a dialog that blocks in its handler cannot block us.
  public static void Press(IntPtr button) { PostMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
}
'@

# The editor's own windows, plus those of the processes it started (the licensing client, for one).
$all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
$set = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($p in $Pids -split '[,\s]+' | Where-Object { $_ }) { [void]$set.Add([uint32]$p) }
for ($grew = $true; $grew; ) {
  $grew = $false
  foreach ($p in $all) { if ($set.Contains([uint32]$p.ParentProcessId) -and $set.Add([uint32]$p.ProcessId)) { $grew = $true } }
}

function Describe([IntPtr]$h) {
  $texts = New-Object System.Collections.Generic.List[string]
  $buttons = New-Object System.Collections.Generic.List[string]
  $kids = [FfsbWin]::Children($h)
  foreach ($c in $kids) {
    $cls = [FfsbWin]::ClassOf($c)
    if ($cls -eq 'Button') { if ($buttons.Count -lt 12) { $t = [FfsbWin]::TextOf($c); if ($t.Trim()) { $buttons.Add($t) } } }
    elseif ($cls -eq 'Static' -or $cls -eq 'Edit' -or $cls -like 'RichEdit*') { if ($texts.Count -lt 20) { $t = [FfsbWin]::TextOf($c); if ($t.Trim()) { $texts.Add($t) } } }
  }
  if ($kids.Count -eq 0 -or ($texts.Count -eq 0 -and $buttons.Count -eq 0 -and [FfsbWin]::ClassOf($h) -eq '#32770')) {
    try {
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $CT = [System.Windows.Automation.ControlType]
      $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
      foreach ($d in $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        $name = [string]$d.Current.Name
        if (!$name.Trim()) { continue }
        if ($d.Current.ControlType -eq $CT::Button) { if ($buttons.Count -lt 12) { $buttons.Add($name) } }
        elseif ($texts.Count -lt 20) { $texts.Add($name) }
      }
    } catch { }
  }
  [pscustomobject]@{
    hwnd    = [long]$h
    pid     = [FfsbWin]::PidOf($h)
    class   = [FfsbWin]::ClassOf($h)
    title   = [FfsbWin]::TitleOf($h)
    enabled = [FfsbWin]::IsWindowEnabled($h)
    owned   = [FfsbWin]::GetWindow($h, 4) -ne [IntPtr]::Zero   # GW_OWNER
    text    = @($texts)
    buttons = @($buttons)
  }
}

if ($Click) {
  $h = [IntPtr]$Hwnd
  if (![FfsbWin]::IsWindow($h) -or !$set.Contains([FfsbWin]::PidOf($h))) { throw "window $Hwnd is gone or does not belong to pids $Pids" }
  $btn = [FfsbWin]::Children($h) | Where-Object { [FfsbWin]::ClassOf($_) -eq 'Button' -and ([FfsbWin]::TextOf($_) -replace '&', '') -eq ($Click -replace '&', '') } | Select-Object -First 1
  if (!$btn) { throw "no button '$Click' in window $Hwnd" }
  [FfsbWin]::Press($btn)
  for ($i = 0; $i -lt 10 -and [FfsbWin]::IsWindow($h) -and [FfsbWin]::IsWindowVisible($h); $i++) { Start-Sleep -Milliseconds 200 }
  [pscustomobject]@{ clicked = $Click; hwnd = $Hwnd; stillOpen = [FfsbWin]::IsWindow($h) -and [FfsbWin]::IsWindowVisible($h) } | ConvertTo-Json -Compress
  return
}

$out = @(foreach ($h in [FfsbWin]::TopLevel($set)) { Describe $h })
ConvertTo-Json -InputObject $out -Depth 4 -Compress
