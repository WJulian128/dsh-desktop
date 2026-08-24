// win-control.exe —— DSH 桌面端的 Windows 操控助手（C# + user32 P/Invoke）。
// 由 main/win-control.js 在首次使用时用 PowerShell Add-Type 编译。
// 子命令输出 JSON 到 stdout；错误输出 { "error": "..." } 并退出码 1。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace WinControl
{
    static class Program
    {
        // ---- user32 / kernel32 P/Invoke ----
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
        [DllImport("user32.dll")] static extern bool SetWindowText(IntPtr h, string s);
        [DllImport("user32.dll")] static extern bool SendInputOK(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
        [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        // DPI 感知：让 Screen.Bounds / SetCursorPos / GetWindowRect / MoveWindow 全部使用
        // 物理像素，与截图文件（1920×1080 等）同一坐标系，避免缩放（如 125%）导致坐标错位。
        static void EnableDpiAware()
        {
            try { if (SetProcessDpiAwarenessContext((IntPtr)(-4)) != IntPtr.Zero) return; } catch { }
            try { if (SetProcessDpiAwarenessContext((IntPtr)(-2)) != IntPtr.Zero) return; } catch { }
            try { SetProcessDPIAware(); } catch { }
        }

        const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
            MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020,
            MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000,
            MOUSEEVENTF_ABSOLUTE = 0x8000;
        const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
        const int SW_MINIMIZE = 6, SW_RESTORE = 9, SW_MAXIMIZE = 3, SW_SHOW = 5;
        const uint WM_CLOSE = 0x0010;

        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

        static void Fail(string msg) { Console.WriteLine("{\"error\":\"" + JsonEscape(msg) + "\"}"); Environment.Exit(1); }
        static string JsonEscape(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r"); }

        static readonly Dictionary<string, ushort> VK = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            {"enter", 0x0D}, {"return", 0x0D}, {"tab", 0x09}, {"esc", 0x1B}, {"escape", 0x1B},
            {"backspace", 0x08}, {"delete", 0x2E}, {"space", 0x20}, {"insert", 0x2D}, {"home", 0x24},
            {"end", 0x23}, {"pageup", 0x21}, {"pagedown", 0x22}, {"up", 0x26}, {"down", 0x28},
            {"left", 0x25}, {"right", 0x27}, {"ctrl", 0x11}, {"control", 0x11}, {"shift", 0x10},
            {"alt", 0x12}, {"menu", 0x12}, {"win", 0x5B}, {"lwin", 0x5B}, {"rwin", 0x5C},
            {"capslock", 0x14}, {"printscreen", 0x2C}, {"pause", 0x13}, {"f1", 0x70}, {"f2", 0x71},
            {"f3", 0x72}, {"f4", 0x73}, {"f5", 0x74}, {"f6", 0x75}, {"f7", 0x76}, {"f8", 0x77},
            {"f9", 0x78}, {"f10", 0x79}, {"f11", 0x7A}, {"f12", 0x7B},
        };

        static ushort ResolveVk(string key)
        {
            ushort v;
            if (VK.TryGetValue(key, out v)) return v;
            if (key.Length == 1) { char c = char.ToUpper(key[0]); if (c >= 'A' && c <= 'Z') return (ushort)c; if (c >= '0' && c <= '9') return (ushort)c; }
            return 0;
        }

        static void SendMouse(INPUT[] inputs)
        {
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length) Fail("SendInput 失败");
        }

        static INPUT MouseInput(uint flags, int dx, int dy, int data)
        {
            INPUT i = new INPUT(); i.type = INPUT_MOUSE;
            i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = (uint)data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
            return i;
        }

        static void CmdMouse(string[] args)
        {
            string action = args.Length > 1 ? args[1] : "";
            int x = 0, y = 0, dx = 0, dy = 0, amount = 0;
            for (int i = 2; i + 1 < args.Length; i += 2)
            {
                int n;
                var v = int.TryParse(args[i + 1], out n) ? n : 0;
                switch (args[i]) { case "--x": x = v; break; case "--y": y = v; break; case "--dx": dx = v; break; case "--dy": dy = v; break; case "--amount": amount = v; break; }
            }
            var inputs = new List<INPUT>();
            switch (action)
            {
                case "move": SetCursorPos(x, y); Console.WriteLine("{\"ok\":true}"); return;
                case "position": POINT pt; GetCursorPos(out pt); Console.WriteLine("{\"ok\":true,\"x\":" + pt.X + ",\"y\":" + pt.Y + "}"); return;
                case "click":
                    inputs.Add(MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, (int)(x * 65535.0 / (Screen.PrimaryScreen.Bounds.Width - 1)), (int)(y * 65535.0 / (Screen.PrimaryScreen.Bounds.Height - 1)), 0));
                    inputs.Add(MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)); inputs.Add(MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0)); break;
                case "rightclick":
                    inputs.Add(MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, (int)(x * 65535.0 / (Screen.PrimaryScreen.Bounds.Width - 1)), (int)(y * 65535.0 / (Screen.PrimaryScreen.Bounds.Height - 1)), 0));
                    inputs.Add(MouseInput(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0)); inputs.Add(MouseInput(MOUSEEVENTF_RIGHTUP, 0, 0, 0)); break;
                case "doubleclick":
                    inputs.Add(MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, (int)(x * 65535.0 / (Screen.PrimaryScreen.Bounds.Width - 1)), (int)(y * 65535.0 / (Screen.PrimaryScreen.Bounds.Height - 1)), 0));
                    inputs.Add(MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)); inputs.Add(MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0));
                    inputs.Add(MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)); inputs.Add(MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0)); break;
                case "drag":
                    inputs.Add(MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, (int)(x * 65535.0 / (Screen.PrimaryScreen.Bounds.Width - 1)), (int)(y * 65535.0 / (Screen.PrimaryScreen.Bounds.Height - 1)), 0));
                    inputs.Add(MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0));
                    inputs.Add(MouseInput(MOUSEEVENTF_MOVE, dx, dy, 0));
                    inputs.Add(MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0)); break;
                case "scroll":
                    inputs.Add(MouseInput(MOUSEEVENTF_WHEEL, 0, 0, amount * 120)); break;
                case "hscroll":
                    inputs.Add(MouseInput(MOUSEEVENTF_HWHEEL, 0, 0, amount * 120)); break;
                default: Fail("未知鼠标动作: " + action); return;
            }
            SendMouse(inputs.ToArray());
            Console.WriteLine("{\"ok\":true}");
        }

        static void CmdKeyboard(string[] args)
        {
            string action = args.Length > 1 ? args[1] : "";
            string text = "";
            string keys = "";
            for (int i = 2; i + 1 < args.Length; i += 2)
            {
                if (args[i] == "--text") text = args[i + 1];
                if (args[i] == "--keys") keys = args[i + 1];
            }
            var inputs = new List<INPUT>();
            if (action == "type")
            {
                foreach (char c in text)
                {
                    inputs.Add(new INPUT { type = INPUT_KEYBOARD, u = { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE, time = 0, dwExtraInfo = IntPtr.Zero } } });
                    inputs.Add(new INPUT { type = INPUT_KEYBOARD, u = { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero } } });
                }
            }
            else if (action == "press")
            {
                foreach (var key in keys.Split(','))
                {
                    var k = key.Trim();
                    if (k.Length == 0) continue;
                    ushort vk = ResolveVk(k);
                    if (vk == 0) Fail("未知按键: " + k);
                    inputs.Add(new INPUT { type = INPUT_KEYBOARD, u = { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = 0, time = 0, dwExtraInfo = IntPtr.Zero } } });
                    inputs.Add(new INPUT { type = INPUT_KEYBOARD, u = { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero } } });
                }
            }
            else Fail("未知键盘动作: " + action);
            SendMouse(inputs.ToArray());
            Console.WriteLine("{\"ok\":true}");
        }

        static List<IntPtr> EnumWindows()
        {
            var result = new List<IntPtr>();
            EnumWindows((h, l) => { result.Add(h); return true; }, IntPtr.Zero);
            return result;
        }

        static IntPtr FindWindowByTitle(string part)
        {
            var p = part.ToLowerInvariant();
            foreach (var h in EnumWindows())
            {
                if (!IsWindowVisible(h)) continue;
                int len = GetWindowTextLength(h);
                if (len == 0) continue;
                var sb = new StringBuilder(len + 1);
                GetWindowText(h, sb, sb.Capacity);
                if (sb.ToString().ToLowerInvariant().Contains(p)) return h;
            }
            return IntPtr.Zero;
        }

        static void CmdWindow(string[] args)
        {
            string action = args.Length > 1 ? args[1] : "";
            string title = null, hwndStr = null;
            int x = 0, y = 0, w = 0, h = 0;
            for (int i = 2; i + 1 < args.Length; i += 2)
            {
                switch (args[i])
                {
                    case "--title": title = args[i + 1]; break;
                    case "--hwnd": hwndStr = args[i + 1]; break;
                    case "--x": x = int.Parse(args[i + 1]); break;
                    case "--y": y = int.Parse(args[i + 1]); break;
                    case "--w": w = int.Parse(args[i + 1]); break;
                    case "--h": h = int.Parse(args[i + 1]); break;
                }
            }
            IntPtr hwnd = IntPtr.Zero;
            if (!string.IsNullOrEmpty(hwndStr)) hwnd = new IntPtr(long.Parse(hwndStr));
            else if (!string.IsNullOrEmpty(title)) hwnd = FindWindowByTitle(title);

            switch (action)
            {
                case "list":
                    {
                        var items = new List<string>();
                        foreach (var hh in EnumWindows())
                        {
                            if (!IsWindowVisible(hh)) continue;
                            int len = GetWindowTextLength(hh);
                            if (len == 0) continue;
                            var sb = new StringBuilder(len + 1);
                            GetWindowText(hh, sb, sb.Capacity);
                            RECT rect; if (!GetWindowRect(hh, out rect)) continue;
                            items.Add("{\"hwnd\":" + hh.ToInt64() + ",\"title\":\"" + JsonEscape(sb.ToString()) + "\",\"x\":" + rect.Left + ",\"y\":" + rect.Top + ",\"w\":" + (rect.Right - rect.Left) + ",\"h\":" + (rect.Bottom - rect.Top) + "}");
                        }
                        Console.WriteLine("{\"ok\":true,\"windows\":[" + string.Join(",", items) + "]}");
                        return;
                    }
                case "active":
                    {
                        IntPtr fg = GetForegroundWindow();
                        int len = GetWindowTextLength(fg);
                        var sb = new StringBuilder(len + 1);
                        GetWindowText(fg, sb, sb.Capacity);
                        Console.WriteLine("{\"ok\":true,\"hwnd\":" + fg.ToInt64() + ",\"title\":\"" + JsonEscape(sb.ToString()) + "\"}");
                        return;
                    }
                case "focus": if (hwnd == IntPtr.Zero) Fail("找不到窗口: " + (title ?? "")); SetForegroundWindow(hwnd); break;
                case "minimize": if (hwnd == IntPtr.Zero) Fail("找不到窗口: " + (title ?? "")); ShowWindow(hwnd, SW_MINIMIZE); break;
                case "maximize": if (hwnd == IntPtr.Zero) Fail("找不到窗口: " + (title ?? "")); ShowWindow(hwnd, SW_MAXIMIZE); break;
                case "restore": if (hwnd == IntPtr.Zero) Fail("找不到窗口: " + (title ?? "")); ShowWindow(hwnd, SW_RESTORE); break;
                case "move": if (hwnd == IntPtr.Zero) Fail("找不到窗口: " + (title ?? "")); MoveWindow(hwnd, x, y, w > 0 ? w : 800, h > 0 ? h : 600, true); break;
                case "resize": if (hwnd == IntPtr.Zero) Fail("找不到窗口: " + (title ?? "")); MoveWindow(hwnd, x, y, w, h, true); break;
                case "close": if (hwnd == IntPtr.Zero) Fail("找不到窗口: " + (title ?? "")); PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); break;
                default: Fail("未知窗口动作: " + action); return;
            }
            Console.WriteLine("{\"ok\":true}");
        }

        static void CmdClipboard(string[] args)
        {
            string action = args.Length > 1 ? args[1] : "";
            string text = "";
            for (int i = 2; i + 1 < args.Length; i += 2) if (args[i] == "--text") text = args[i + 1];
            if (action == "set") { Clipboard.SetText(text); Console.WriteLine("{\"ok\":true}"); }
            else if (action == "get") { Console.WriteLine("{\"ok\":true,\"text\":\"" + JsonEscape(Clipboard.GetText()) + "\"}"); }
            else Fail("未知剪贴板动作: " + action);
        }

        static void CmdScreen(string[] args)
        {
            var b = Screen.PrimaryScreen.Bounds;
            Console.WriteLine("{\"ok\":true,\"width\":" + b.Width + ",\"height\":" + b.Height + "}");
        }

        static void CmdLaunch(string[] args)
        {
            string target = "";
            for (int i = 2; i + 1 < args.Length; i += 2) if (args[i] == "--target") target = args[i + 1];
            if (string.IsNullOrEmpty(target)) Fail("缺少启动目标");
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); Console.WriteLine("{\"ok\":true}"); }
            catch (Exception ex) { Fail("启动失败: " + ex.Message); }
        }

        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                EnableDpiAware(); // 必须在任何坐标/Screen 使用之前
                Console.OutputEncoding = new UTF8Encoding(false);
                if (args.Length == 0) { Fail("缺少子命令"); return 1; }
                switch (args[0])
                {
                    case "mouse": CmdMouse(args); return 0;
                    case "keyboard": CmdKeyboard(args); return 0;
                    case "window": CmdWindow(args); return 0;
                    case "clipboard": CmdClipboard(args); return 0;
                    case "screen": CmdScreen(args); return 0;
                    case "launch": CmdLaunch(args); return 0;
                    default: Fail("未知子命令: " + args[0]); return 1;
                }
            }
            catch (Exception ex) { Fail(ex.Message); return 1; }
        }
    }
}
