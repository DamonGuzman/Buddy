$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class BuddyInput {
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint count, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

  const uint INPUT_KEYBOARD = 1;
  const uint KEYUP = 0x0002;
  const uint UNICODE = 0x0004;
  const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;

  static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
    {"BACKSPACE", 0x08}, {"TAB", 0x09}, {"ENTER", 0x0D}, {"SHIFT", 0x10},
    {"CTRL", 0x11}, {"CONTROL", 0x11}, {"ALT", 0x12}, {"ESC", 0x1B}, {"ESCAPE", 0x1B},
    {"SPACE", 0x20}, {"PAGEUP", 0x21}, {"PAGEDOWN", 0x22}, {"END", 0x23}, {"HOME", 0x24},
    {"LEFT", 0x25}, {"UP", 0x26}, {"RIGHT", 0x27}, {"DOWN", 0x28},
    {"DELETE", 0x2E}, {"WIN", 0x5B}, {"META", 0x5B}
  };

  static INPUT Key(ushort vk, uint flags) {
    return new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION {
      ki = new KEYBDINPUT { wVk = vk, dwFlags = flags }
    }};
  }

  public static void Click(int x, int y, string button, int count) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
    uint down = LEFTDOWN, up = LEFTUP;
    if (String.Equals(button, "right", StringComparison.OrdinalIgnoreCase)) { down = RIGHTDOWN; up = RIGHTUP; }
    if (String.Equals(button, "middle", StringComparison.OrdinalIgnoreCase)) { down = MIDDLEDOWN; up = MIDDLEUP; }
    for (int i = 0; i < Math.Max(1, Math.Min(count, 2)); i++) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); }
  }

  public static void TypeText(string text) {
    foreach (char ch in text ?? "") {
      var inputs = new [] {
        new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = ch, dwFlags = UNICODE } } },
        new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = ch, dwFlags = UNICODE | KEYUP } } }
      };
      if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput text failed");
    }
  }

  public static void Press(string[] names) {
    var codes = new List<ushort>();
    foreach (string raw in names ?? new string[0]) {
      string name = (raw ?? "").Trim().ToUpperInvariant();
      ushort code;
      if (Keys.TryGetValue(name, out code)) codes.Add(code);
      else if (name.Length == 1) codes.Add((ushort)name[0]);
      else {
        int f;
        if (name.StartsWith("F") && Int32.TryParse(name.Substring(1), out f) && f >= 1 && f <= 24) codes.Add((ushort)(0x70 + f - 1));
        else throw new ArgumentException("unsupported key: " + raw);
      }
    }
    if (codes.Count == 0) throw new ArgumentException("at least one key is required");
    var inputs = new List<INPUT>();
    foreach (ushort code in codes) inputs.Add(Key(code, 0));
    for (int i = codes.Count - 1; i >= 0; i--) inputs.Add(Key(codes[i], KEYUP));
    if (SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT))) != inputs.Count) throw new InvalidOperationException("SendInput keys failed");
  }
}
'@

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = 0
  try {
    $request = $line | ConvertFrom-Json
    $id = [int]$request.id
    switch ([string]$request.action) {
      'click' { [BuddyInput]::Click([int]$request.x, [int]$request.y, [string]$request.button, [int]$request.count) }
      'type_text' { [BuddyInput]::TypeText([string]$request.text) }
      'press_keys' { [BuddyInput]::Press([string[]]$request.keys) }
      default { throw "unknown action" }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true } | ConvertTo-Json -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
}
