// The FF Factory tray app (w1532, docs/machines.md "Pausing a machine"). The machine daemon builds it with the C# compiler
// every Windows PC has (.NET Framework 4, csc.exe: so C# 5, no string interpolation or ?.), starts it in the logged-on
// user's session and talks to it over its stdin and stdout, one JSON object per line (machine/tray.ts):
//   daemon -> tray  {"type":"state", ...}  what to show; {"type":"show_menu"} / {"type":"hide_menu"} /
//                   {"type":"show_schedule"} / {"type":"hide_schedule"} open and close them for a still; {"type":"counts"}
//                   answered by the keys and clicks seen since it started, a person's and injected; {"type":"quit"}
//   tray -> daemon  {"type":"hello"}, {"type":"pause"}, {"type":"unpause"}, {"type":"settings","settings":{...}},
//                   {"type":"input","kind":"key"|"click","at":<epoch ms>} a person's key or click (at most one per
//                   INPUT_EVERY_MS), {"type":"injected","keys":n,"clicks":n} input programs injected, ignored (once a
//                   minute when there was any), {"type":"log","text":"..."}
// It ends when its stdin closes (the daemon stopped), so an update's new daemon starts the new build.
//
// A person's input is a key press or a mouse button press that the low-level hooks see without the injected flag
// (LLKHF_INJECTED / LLMHF_INJECTED, and their lower-integrity forms): SendInput, keybd_event and mouse_event, which agents
// and test tools use to drive the game, set it; a keyboard or mouse does not. Moving the mouse does not count.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("FF Factory tray")]
[assembly: AssemblyProduct("FF Factory")]

namespace FFFactory
{
    static class Native
    {
        public const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
        public const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
        public const int WM_LBUTTONDOWN = 0x201, WM_RBUTTONDOWN = 0x204, WM_MBUTTONDOWN = 0x207, WM_XBUTTONDOWN = 0x20B;
        public const int LLKHF_LOWER_IL_INJECTED = 0x02, LLKHF_INJECTED = 0x10;
        public const int LLMHF_INJECTED = 0x01, LLMHF_LOWER_IL_INJECTED = 0x02;

        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
        [DllImport("kernel32.dll")]
        public static extern bool ProcessIdToSessionId(uint pid, out uint session);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        public struct NOTIFYICONIDENTIFIER { public uint cbSize; public IntPtr hWnd; public uint uID; public Guid guidItem; }
        [DllImport("shell32.dll")]
        public static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER identifier, out RECT iconLocation);
    }

    class TrayApp : ApplicationContext
    {
        const int INPUT_EVERY_MS = 5000;
        static readonly Color Ink = Color.FromArgb(0x1F, 0x23, 0x28);
        static readonly Color Muted = Color.FromArgb(0x57, 0x60, 0x6A);
        static readonly Color RunColour = Color.FromArgb(0x1A, 0x7F, 0x37);
        static readonly Color PauseColour = Color.FromArgb(0xBC, 0x4C, 0x00);

        readonly string dir;
        readonly NotifyIcon icon = new NotifyIcon();
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly ToolStripLabel title = new ToolStripLabel();
        readonly ToolStripLabel stateLine = new ToolStripLabel();
        readonly ToolStripLabel whyLine = new ToolStripLabel();
        readonly ToolStripLabel nextLine = new ToolStripLabel();
        readonly ToolStripLabel workLine = new ToolStripLabel();
        readonly ToolStripMenuItem toggle = new ToolStripMenuItem();
        readonly ToolStripMenuItem schedule = new ToolStripMenuItem();
        readonly ToolStripMenuItem activity = new ToolStripMenuItem();
        readonly ToolStripMenuItem portal = new ToolStripMenuItem("Open FF Factory");
        readonly Icon runIcon, pausedIcon;
        readonly Image runDot, pausedDot;
        readonly object outLock = new object();
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer();
        // A window made at start, for the stdin reader to hand messages to the UI thread (the menu has none until it opens).
        readonly Control ui = new Control();

        Native.HookProc keyProc, mouseProc;
        IntPtr keyHook = IntPtr.Zero, mouseHook = IntPtr.Zero;
        static long lastKey, lastClick, injectedKeys, injectedClicks;
        // Since it started, for the daemon's counts message (a test, the evidence of what was injected).
        static long personKeys, personClicks, allInjectedKeys, allInjectedClicks, repeats;
        // Keys held down now (by a person's keyboard): a held key's auto-repeat is not a new press. w1532 found beast with its
        // Left Ctrl held down for good (30 repeats a second, never released, nobody at the mouse): only a press counts.
        static readonly bool[] held = new bool[256];
        long sentInput;
        DateTime lastInputSent = DateTime.MinValue, lastInjectedReport = DateTime.UtcNow, hooksAt = DateTime.UtcNow;
        bool paused, haveState;
        string portalUrl;
        Dictionary<string, object> settings;
        ScheduleForm scheduleForm;

        public TrayApp(string dir)
        {
            this.dir = dir;
            ui.CreateControl();
            IntPtr made = ui.Handle;
            runIcon = LoadIcon("fff.ico");
            pausedIcon = LoadIcon("fff-paused.ico");
            runDot = Dot(RunColour);
            pausedDot = Dot(PauseColour);

            title.Font = new Font(menu.Font, FontStyle.Bold);
            title.ForeColor = Ink;
            title.Text = "FF Factory";
            stateLine.Font = new Font(menu.Font, FontStyle.Bold);
            whyLine.ForeColor = Ink;
            nextLine.ForeColor = Muted;
            workLine.ForeColor = Muted;
            foreach (ToolStripLabel l in new[] { title, stateLine, whyLine, nextLine, workLine }) l.Padding = new Padding(0, 1, 0, 1);
            toggle.Font = new Font(menu.Font, FontStyle.Bold);
            toggle.Click += delegate { Send(new Dictionary<string, object> { { "type", paused ? "unpause" : "pause" } }); };
            schedule.Click += delegate { ShowSchedule(); };
            activity.CheckOnClick = false;
            activity.Text = "Pause when someone uses this PC";
            activity.Click += delegate { ToggleActivity(); };
            portal.Click += delegate { if (!string.IsNullOrEmpty(portalUrl)) try { Process.Start(portalUrl); } catch (Exception e) { Log("could not open the portal: " + e.Message); } };

            menu.ShowImageMargin = true;
            menu.Items.AddRange(new ToolStripItem[] { title, stateLine, whyLine, nextLine, workLine, new ToolStripSeparator(), toggle, new ToolStripSeparator(), schedule, activity, new ToolStripSeparator(), portal });
            icon.ContextMenuStrip = menu;
            icon.MouseUp += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ShowMenuAtCursor(); };
            Render(null);
            icon.Visible = true;

            InstallHooks();
            tick.Interval = 1000;
            tick.Tick += delegate { OnTick(); };
            tick.Start();

            uint session;
            Native.ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out session);
            Send(new Dictionary<string, object> { { "type", "hello" }, { "pid", Process.GetCurrentProcess().Id }, { "session", (int)session }, { "hooks", keyHook != IntPtr.Zero && mouseHook != IntPtr.Zero ? "keyboard and mouse" : "failed" } });
            var reader = new Thread(ReadLoop);
            reader.IsBackground = true;
            reader.Start();
            var promote = new System.Windows.Forms.Timer();
            promote.Interval = 4000;
            promote.Tick += delegate { promote.Stop(); Promote(); };
            promote.Start();
        }

        Icon LoadIcon(string name)
        {
            try { return new Icon(Path.Combine(dir, name), SystemInformation.SmallIconSize); }
            catch (Exception e) { Log("icon " + name + ": " + e.Message); return SystemIcons.Application; }
        }

        static Image Dot(Color c)
        {
            int s = SystemInformation.SmallIconSize.Width;
            var b = new Bitmap(s, s);
            using (var g = Graphics.FromImage(b))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                float d = s * 0.5f, o = (s - d) / 2;
                using (var br = new SolidBrush(c)) g.FillEllipse(br, o, o, d, d);
            }
            return b;
        }

        // ------------------------------------------------------------------ input

        void InstallHooks()
        {
            keyProc = KeyboardProc;
            mouseProc = MouseProc;
            // A key already down when the hook starts (stuck, or held) is not a press either.
            for (int vk = 1; vk < 256; vk++) if ((Native.GetAsyncKeyState(vk) & 0x8000) != 0) held[vk] = true;
            IntPtr mod = Native.GetModuleHandle(null);
            keyHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, keyProc, mod, 0);
            if (keyHook == IntPtr.Zero) Log("the keyboard hook failed: error " + Marshal.GetLastWin32Error());
            mouseHook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, mouseProc, mod, 0);
            if (mouseHook == IntPtr.Zero) Log("the mouse hook failed: error " + Marshal.GetLastWin32Error());
            hooksAt = DateTime.UtcNow;
        }

        void RemoveHooks()
        {
            if (keyHook != IntPtr.Zero) Native.UnhookWindowsHookEx(keyHook);
            if (mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(mouseHook);
            keyHook = mouseHook = IntPtr.Zero;
        }

        // Kept as short as possible: Windows drops a low-level hook that is slow to answer, without telling it.
        static IntPtr KeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                int vk = Marshal.ReadInt32(lParam, 0) & 0xFF;
                int flags = Marshal.ReadInt32(lParam, 8); // KBDLLHOOKSTRUCT: vkCode, scanCode, flags
                bool injected = (flags & (Native.LLKHF_INJECTED | Native.LLKHF_LOWER_IL_INJECTED)) != 0;
                if (msg == Native.WM_KEYDOWN || msg == Native.WM_SYSKEYDOWN)
                {
                    if (injected) { Interlocked.Increment(ref injectedKeys); Interlocked.Increment(ref allInjectedKeys); }
                    else if (held[vk]) Interlocked.Increment(ref repeats);
                    else { held[vk] = true; Interlocked.Exchange(ref lastKey, DateTime.UtcNow.Ticks); Interlocked.Increment(ref personKeys); }
                }
                else if ((msg == Native.WM_KEYUP || msg == Native.WM_SYSKEYUP) && !injected) held[vk] = false;
            }
            return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        static IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == Native.WM_LBUTTONDOWN || msg == Native.WM_RBUTTONDOWN || msg == Native.WM_MBUTTONDOWN || msg == Native.WM_XBUTTONDOWN)
                {
                    int flags = Marshal.ReadInt32(lParam, 12); // MSLLHOOKSTRUCT: pt (8 bytes), mouseData, flags
                    if ((flags & (Native.LLMHF_INJECTED | Native.LLMHF_LOWER_IL_INJECTED)) != 0) { Interlocked.Increment(ref injectedClicks); Interlocked.Increment(ref allInjectedClicks); }
                    else { Interlocked.Exchange(ref lastClick, DateTime.UtcNow.Ticks); Interlocked.Increment(ref personClicks); }
                }
            }
            return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        void OnTick()
        {
            long k = Interlocked.Read(ref lastKey), c = Interlocked.Read(ref lastClick);
            long latest = Math.Max(k, c);
            if (latest > sentInput && (DateTime.UtcNow - lastInputSent).TotalMilliseconds >= INPUT_EVERY_MS)
            {
                sentInput = latest;
                lastInputSent = DateTime.UtcNow;
                long ms = (long)(new DateTime(latest, DateTimeKind.Utc) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                Send(new Dictionary<string, object> { { "type", "input" }, { "kind", k >= c ? "key" : "click" }, { "at", ms } });
            }
            if ((DateTime.UtcNow - lastInjectedReport).TotalSeconds >= 60)
            {
                lastInjectedReport = DateTime.UtcNow;
                long ik = Interlocked.Exchange(ref injectedKeys, 0), ic = Interlocked.Exchange(ref injectedClicks, 0);
                if (ik + ic > 0) Send(new Dictionary<string, object> { { "type", "injected" }, { "keys", ik }, { "clicks", ic } });
            }
            // A hook Windows dropped for a slow answer is never reported: put both back every half hour.
            if ((DateTime.UtcNow - hooksAt).TotalMinutes >= 30)
            {
                RemoveHooks();
                InstallHooks();
            }
        }

        // ------------------------------------------------------------------ the daemon

        void ReadLoop()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    Dictionary<string, object> msg;
                    try { msg = json.Deserialize<Dictionary<string, object>>(line); }
                    catch (Exception e) { Log("unreadable line from the daemon: " + e.Message); continue; }
                    var m = msg;
                    ui.BeginInvoke(new Action(delegate { OnMessage(m); }));
                }
            }
            catch (Exception e) { Log("reading from the daemon failed: " + e.Message); }
            // The daemon is gone (stopped or updated): its successor starts the tray again.
            try { ui.BeginInvoke(new Action(Quit)); } catch { Environment.Exit(0); }
        }

        void OnMessage(Dictionary<string, object> m)
        {
            string type = Str(m, "type");
            if (type == "state") Render(m);
            else if (type == "show_menu") ShowMenuAtIcon();
            else if (type == "hide_menu") menu.Close();
            else if (type == "show_schedule") ShowSchedule();
            else if (type == "hide_schedule") { if (scheduleForm != null) scheduleForm.Close(); }
            else if (type == "counts") Send(new Dictionary<string, object> { { "type", "counts" }, { "personKeys", Interlocked.Read(ref personKeys) }, { "personClicks", Interlocked.Read(ref personClicks) }, { "injectedKeys", Interlocked.Read(ref allInjectedKeys) }, { "injectedClicks", Interlocked.Read(ref allInjectedClicks) }, { "repeats", Interlocked.Read(ref repeats) } });
            else if (type == "quit") Quit();
        }

        void Send(Dictionary<string, object> m)
        {
            string line = json.Serialize(m);
            lock (outLock)
            {
                try { Console.Out.WriteLine(line); Console.Out.Flush(); }
                catch { /* the daemon is gone; ReadLoop ends the app */ }
            }
        }

        void Log(string text) { Send(new Dictionary<string, object> { { "type", "log" }, { "text", text } }); }

        static string Str(Dictionary<string, object> m, string k)
        {
            object v;
            return m != null && m.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
        }

        // ------------------------------------------------------------------ the menu

        void Render(Dictionary<string, object> m)
        {
            haveState = m != null;
            paused = m != null && Equals(m["paused"], true);
            string machine = Str(m, "machine");
            title.Text = string.IsNullOrEmpty(machine) ? "FF Factory" : "FF Factory on " + machine;
            if (!haveState)
            {
                stateLine.Text = "Connecting to the daemon...";
                stateLine.Image = null;
                whyLine.Visible = nextLine.Visible = workLine.Visible = false;
                toggle.Enabled = schedule.Enabled = activity.Enabled = portal.Enabled = false;
                toggle.Text = "Pause all work on this PC";
                schedule.Text = "Work schedule...";
                icon.Icon = runIcon;
                icon.Text = "FF Factory";
                return;
            }
            stateLine.Text = paused ? "Paused" : "Running";
            stateLine.ForeColor = paused ? PauseColour : RunColour;
            stateLine.Image = paused ? pausedDot : runDot;
            SetLine(whyLine, Str(m, "why"));
            SetLine(nextLine, Str(m, "next"));
            SetLine(workLine, Str(m, "work"));
            toggle.Text = paused ? "Unpause: start work again" : "Pause all work on this PC";
            toggle.Enabled = schedule.Enabled = activity.Enabled = true;
            schedule.Text = "Work schedule: " + (Str(m, "schedule") ?? "none") + "...";
            object s;
            settings = m.TryGetValue("settings", out s) ? s as Dictionary<string, object> : null;
            activity.Checked = ActivityOn();
            portalUrl = Str(m, "portalUrl");
            portal.Enabled = !string.IsNullOrEmpty(portalUrl);
            icon.Icon = paused ? pausedIcon : runIcon;
            string tip = "FF Factory: " + (paused ? "paused" : "running") + (Str(m, "tip") != null ? " (" + Str(m, "tip") + ")" : "");
            icon.Text = tip.Length > 63 ? tip.Substring(0, 62) + "…" : tip;
            if (scheduleForm != null && !scheduleForm.IsDisposed) scheduleForm.Machine = machine;
        }

        static void SetLine(ToolStripLabel l, string text)
        {
            l.Visible = !string.IsNullOrEmpty(text);
            l.Text = text ?? "";
        }

        bool ActivityOn()
        {
            object a, e;
            var act = settings != null && settings.TryGetValue("activity", out a) ? a as Dictionary<string, object> : null;
            return act == null || !act.TryGetValue("enabled", out e) || Equals(e, true);
        }

        void ToggleActivity()
        {
            if (settings == null) return;
            var copy = json.Deserialize<Dictionary<string, object>>(json.Serialize(settings));
            var act = copy.ContainsKey("activity") ? copy["activity"] as Dictionary<string, object> : null;
            if (act == null) { act = new Dictionary<string, object>(); copy["activity"] = act; }
            act["enabled"] = !ActivityOn();
            Send(new Dictionary<string, object> { { "type", "settings" }, { "settings", copy } });
        }

        void ShowMenuAtCursor()
        {
            MethodInfo show = typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic);
            if (show != null) show.Invoke(icon, null);
        }

        // For a still of the menu (the daemon's show_menu): opened above the icon, as a right-click there opens it.
        void ShowMenuAtIcon()
        {
            try
            {
                var id = new Native.NOTIFYICONIDENTIFIER();
                id.cbSize = (uint)Marshal.SizeOf(typeof(Native.NOTIFYICONIDENTIFIER));
                var window = (NativeWindow)typeof(NotifyIcon).GetField("window", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(icon);
                id.hWnd = window.Handle;
                id.uID = (uint)(int)typeof(NotifyIcon).GetField("id", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(icon);
                Native.RECT r;
                int hr = Native.Shell_NotifyIconGetRect(ref id, out r);
                if (hr != 0) { Log("the icon's place is unknown (" + hr + "): the menu opens at the cursor"); ShowMenuAtCursor(); return; }
                Send(new Dictionary<string, object> { { "type", "log" }, { "text", "icon at " + r.Left + "," + r.Top + " to " + r.Right + "," + r.Bottom } });
                Cursor.Position = new Point((r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2);
                ShowMenuAtCursor();
            }
            catch (Exception e) { Log("show_menu: " + e.Message); ShowMenuAtCursor(); }
        }

        void ShowSchedule()
        {
            if (settings == null) return;
            if (scheduleForm != null && !scheduleForm.IsDisposed) { scheduleForm.Activate(); return; }
            scheduleForm = new ScheduleForm(settings, runIcon, title.Text.Replace("FF Factory on ", ""));
            scheduleForm.Saved += delegate(Dictionary<string, object> s) { Send(new Dictionary<string, object> { { "type", "settings" }, { "settings", s } }); };
            scheduleForm.Show();
            scheduleForm.Activate();
        }

        // Windows 11 puts a new tray icon in the overflow; lothsahn asked for it in the taskbar. Shown once, the first time
        // only: the person's own choice afterwards (Settings > Personalization > Taskbar) is never undone.
        void Promote()
        {
            string marker = Path.Combine(dir, "promoted");
            if (File.Exists(marker)) return;
            try
            {
                string exe = Application.ExecutablePath;
                using (var root = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings"))
                {
                    if (root == null) return;
                    foreach (string name in root.GetSubKeyNames())
                    {
                        using (var k = root.OpenSubKey(name, true))
                        {
                            if (k == null || !string.Equals(Convert.ToString(k.GetValue("ExecutablePath")), exe, StringComparison.OrdinalIgnoreCase)) continue;
                            k.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                            File.WriteAllText(marker, DateTime.UtcNow.ToString("o"));
                            Log("shown in the taskbar (Windows 11 NotifyIconSettings " + name + ")");
                        }
                    }
                }
            }
            catch (Exception e) { Log("could not show the icon in the taskbar: " + e.Message); }
        }

        void Quit()
        {
            RemoveHooks();
            icon.Visible = false;
            icon.Dispose();
            ExitThread();
        }

        [STAThread]
        static int Main(string[] args)
        {
            string dir = Path.GetDirectoryName(Application.ExecutablePath);
            string instance = args.Length > 1 && args[0] == "--instance" ? args[1] : "default";
            bool mine;
            using (var single = new Mutex(true, @"Local\FFFactoryTray-" + instance, out mine))
            {
                // The tray of a daemon that just stopped may still be closing: wait for it a little.
                if (!mine && !single.WaitOne(15000)) { Console.Out.WriteLine("{\"type\":\"log\",\"text\":\"another tray of this daemon runs: this one ends\"}"); return 3; }
                Native.SetProcessDPIAware();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Console.Out.Flush();
                Application.Run(new TrayApp(dir));
                single.ReleaseMutex();
            }
            return 0;
        }
    }

    class ScheduleForm : Form
    {
        public event Action<Dictionary<string, object>> Saved;
        readonly Dictionary<string, object> settings;
        readonly CheckBox enabled = new CheckBox();
        readonly DateTimePicker from = new DateTimePicker(), to = new DateTimePicker();
        readonly CheckBox[] days = new CheckBox[7];
        readonly Label note = new Label();
        static readonly string[] DayNames = { "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun" };
        static readonly int[] DayNumbers = { 1, 2, 3, 4, 5, 6, 0 };

        public string Machine { set { Text = "FF Factory work schedule" + (string.IsNullOrEmpty(value) ? "" : " - " + value); } }

        public ScheduleForm(Dictionary<string, object> current, Icon icon, string machine)
        {
            var json = new JavaScriptSerializer();
            settings = json.Deserialize<Dictionary<string, object>>(json.Serialize(current));
            var sched = settings.ContainsKey("schedule") ? settings["schedule"] as Dictionary<string, object> : new Dictionary<string, object>();
            Machine = machine;
            Icon = icon;
            Font = new Font("Segoe UI", 9f);
            AutoScaleMode = AutoScaleMode.Font;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(14);
            ShowInTaskbar = true;

            var grid = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
            enabled.Text = "Run FF Factory work on this PC only during these hours";
            enabled.AutoSize = true;
            enabled.Checked = sched != null && Equals(sched["enabled"], true);
            enabled.CheckedChanged += delegate { Sync(); };
            grid.Controls.Add(enabled);

            var hours = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(18, 8, 0, 0) };
            foreach (var p in new[] { from, to })
            {
                p.Format = DateTimePickerFormat.Custom;
                p.CustomFormat = "HH:mm";
                p.ShowUpDown = true;
                p.Width = 70;
            }
            from.Value = Parse(sched, "start", "22:00");
            to.Value = Parse(sched, "end", "08:00");
            hours.Controls.Add(new Label { Text = "From", AutoSize = true, Margin = new Padding(0, 6, 6, 0) });
            hours.Controls.Add(from);
            hours.Controls.Add(new Label { Text = "to", AutoSize = true, Margin = new Padding(10, 6, 6, 0) });
            hours.Controls.Add(to);
            grid.Controls.Add(hours);

            var dayRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(18, 8, 0, 0) };
            var on = new HashSet<int>();
            object list;
            if (sched != null && sched.TryGetValue("days", out list) && list is System.Collections.IEnumerable) foreach (object d in (System.Collections.IEnumerable)list) on.Add(Convert.ToInt32(d));
            else for (int i = 0; i < 7; i++) on.Add(i);
            for (int i = 0; i < 7; i++)
            {
                days[i] = new CheckBox { Text = DayNames[i], AutoSize = true, Checked = on.Contains(DayNumbers[i]), Margin = new Padding(0, 0, 8, 0) };
                dayRow.Controls.Add(days[i]);
            }
            grid.Controls.Add(dayRow);

            note.Text = "Outside these hours FF Factory pauses work on this PC, and its jobs move to other computers. An end before the start runs overnight. Times are this PC's local time.";
            note.MaximumSize = new Size(380, 0);
            note.AutoSize = true;
            note.ForeColor = Color.FromArgb(0x57, 0x60, 0x6A);
            note.Margin = new Padding(0, 12, 0, 0);
            grid.Controls.Add(note);

            var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, Margin = new Padding(0, 14, 0, 0) };
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true, MinimumSize = new Size(80, 0) };
            var save = new Button { Text = "Save", AutoSize = true, MinimumSize = new Size(80, 0) };
            save.Click += delegate { Save(); };
            buttons.Controls.Add(cancel);
            buttons.Controls.Add(save);
            grid.Controls.Add(buttons);
            Controls.Add(grid);
            AcceptButton = save;
            CancelButton = cancel;
            Sync();
        }

        static DateTime Parse(Dictionary<string, object> s, string k, string fallback)
        {
            object v;
            string t = s != null && s.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : fallback;
            DateTime d;
            if (!DateTime.TryParseExact(t, "HH:mm", null, System.Globalization.DateTimeStyles.None, out d)) DateTime.TryParseExact(fallback, "HH:mm", null, System.Globalization.DateTimeStyles.None, out d);
            return DateTime.Today.Add(d.TimeOfDay);
        }

        void Sync()
        {
            from.Enabled = to.Enabled = enabled.Checked;
            foreach (var d in days) d.Enabled = enabled.Checked;
        }

        void Save()
        {
            var list = new List<int>();
            for (int i = 0; i < 7; i++) if (days[i].Checked) list.Add(DayNumbers[i]);
            settings["schedule"] = new Dictionary<string, object> { { "enabled", enabled.Checked }, { "start", from.Value.ToString("HH:mm") }, { "end", to.Value.ToString("HH:mm") }, { "days", list } };
            if (Saved != null) Saved(settings);
            Close();
        }
    }
}
