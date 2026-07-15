# Clicky element-snap daemon (M9) — enumerates on-screen UIA elements near a
# point. Deliberately DUMB: no scoring/matching here (that is pure TS in
# scoring.ts, where it is unit-testable); this script only walks the tree.
#
# Protocol: JSON lines over stdin/stdout, one request -> one response.
#   Request : {"id":1,"x":1234,"y":567,"radiusPx":350,"budgetMs":450,
#              "maxNodes":3000,"excludePid":0}
#             x/y are GLOBAL PHYSICAL px (UIA's native space).
#   Response: {"id":1,"elapsedMs":42,"from":"frompoint","visited":812,
#              "candidates":[{"name":"Save","ct":"Button","x":..,"y":..,"w":..,"h":..}]}
#
# Strategy: Win32 WindowFromPoint (mouse hit-test semantics — naturally skips
# Buddy's WS_EX_TRANSPARENT click-through overlays) selects the first GA_ROOT;
# EnumWindows then adds nearby, visible top-level roots in front-to-back order.
# Each root gets a fair DFS time/node slice with bounding-rect pruning, which
# keeps split-view and point-drift cases from starving the adjacent app. A
# CacheRequest batches the properties read per element into one cross-process
# call. UIA's own FromPoint remains only a fallback because it ignores hit-test
# transparency. Elements of the excluded Buddy pid are never used as a scope.

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ClickySnapWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  // Front-to-back top-level windows intersecting the point's search square.
  // The exact WindowFromPoint root is first, then nearby visible roots. This
  // keeps split-view robust when the model point drifts across the divider.
  public static IntPtr[] CandidateWindows(int x, int y, int radius, int excludePid, int max) {
    var result = new List<IntPtr>();
    var seen = new HashSet<IntPtr>();
    Action<IntPtr> add = (hwnd) => {
      if (hwnd == IntPtr.Zero) return;
      var root = GetAncestor(hwnd, 2); // GA_ROOT
      if (root == IntPtr.Zero) root = hwnd;
      uint pid;
      GetWindowThreadProcessId(root, out pid);
      if ((excludePid >= 0 && pid == (uint)excludePid) || !seen.Add(root)) return;
      result.Add(root);
    };
    var point = new POINT { X = x, Y = y };
    add(WindowFromPoint(point));
    EnumWindows((hwnd, _) => {
      if (result.Count >= max) return false;
      if (!IsWindowVisible(hwnd)) return true;
      RECT r;
      if (!GetWindowRect(hwnd, out r) || r.Right <= r.Left || r.Bottom <= r.Top) return true;
      if (r.Right < x - radius || r.Left > x + radius ||
          r.Bottom < y - radius || r.Top > y + radius) return true;
      add(hwnd);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
"@

# CRITICAL: PowerShell is DPI-unaware by default, which VIRTUALIZES user32
# coordinates (WindowFromPoint would live in 96-DPI space) while UIA rects
# stay physical — mixed spaces broke window resolution on 4K@150%. Per
# Monitor V2 makes user32 and UIA agree on physical px.
try {
  [void][ClickySnapWin32]::SetProcessDpiAwarenessContext((New-Object IntPtr(-4))) # PER_MONITOR_AWARE_V2
} catch {
  try { [void][ClickySnapWin32]::SetProcessDPIAware() } catch { }
}

$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$root = $AE::RootElement

$cache = New-Object System.Windows.Automation.CacheRequest
$cache.Add($AE::NameProperty)
$cache.Add($AE::BoundingRectangleProperty)
$cache.Add($AE::IsOffscreenProperty)
$cache.Add($AE::ControlTypeProperty)
$cache.Add($AE::HelpTextProperty)
$cache.Add($AE::ProcessIdProperty)
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element

function Get-TopWindow($el) {
  $current = $el
  for ($i = 0; $i -lt 40; $i++) {
    $parent = $walker.GetParent($current)
    if ($null -eq $parent) { return $current }
    if ([System.Windows.Automation.Automation]::Compare($parent, $root)) { return $current }
    $current = $parent
  }
  return $current
}

function Handle-Request($req) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $x = [double]$req.x; $y = [double]$req.y
  $radius = 350.0; if ($req.radiusPx) { $radius = [double]$req.radiusPx }
  $budgetMs = 450; if ($req.budgetMs) { $budgetMs = [int]$req.budgetMs }
  $maxNodes = 3000; if ($req.maxNodes) { $maxNodes = [int]$req.maxNodes }
  $excludePid = -1; if ($req.excludePid) { $excludePid = [int]$req.excludePid }
  $searchRect = New-Object System.Windows.Rect(($x - $radius), ($y - $radius), (2.0 * $radius), (2.0 * $radius))
  $pt = New-Object System.Windows.Point($x, $y)

  # --- scopes: point window + nearby visible top-level windows ---
  # This is deliberately a bounded scene, not "the frontmost app". A model
  # point near a split-view divider can still match the named control in the
  # adjacent app; z-order and proximity remain shared-TS tie-breakers.
  $scopes = New-Object System.Collections.Generic.List[object]
  $from = $null
  try {
    $handles = [ClickySnapWin32]::CandidateWindows(
      [int][Math]::Round($x), [int][Math]::Round($y), [int][Math]::Round($radius),
      $excludePid, 6)
    foreach ($hwnd in $handles) {
      try {
        $scope = $AE::FromHandle($hwnd)
        if ($null -ne $scope) { $scopes.Add($scope) }
      } catch { }
    }
    if ($scopes.Count -gt 0) { $from = 'visible-window-scene' }
  } catch { }
  if ($scopes.Count -eq 0) {
    # Fallback: UIA's own hit test (can land on windows WindowFromPoint
    # skips, e.g. when the point sits on a disabled control).
    try {
      $hit = $AE::FromPoint($pt)
      if ($null -ne $hit -and ($excludePid -lt 0 -or $hit.Current.ProcessId -ne $excludePid)) {
        $scopes.Add((Get-TopWindow $hit))
        $from = 'frompoint'
      }
    } catch { }
  }

  # --- DFS with rect pruning under node/time budgets ---
  $cands = New-Object System.Collections.Generic.List[object]
  $visited = 0
  if ($scopes.Count -gt 0) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($budgetMs)
    # Give each visible window a fair node/time/candidate slice. A complex
    # front window must not consume the entire budget before an adjacent app.
    for ($scopeIndex = 0; $scopeIndex -lt $scopes.Count; $scopeIndex++) {
      if ($visited -ge $maxNodes) { break }
      # A remote provider can spend the entire nominal slice in
      # GetUpdatedCache before we inspect even one node. Always probe a small
      # prefix of the first three windows (point window + likely split-view
      # neighbors); the TS caller still enforces the hard response timebox.
      $mustProbeScope = $scopeIndex -lt [Math]::Min(3, $scopes.Count)
      if (-not $mustProbeScope -and [DateTime]::UtcNow -ge $deadline) { break }
      $scopesLeft = [Math]::Max(1, $scopes.Count - $scopeIndex)
      $scopeNodeBudget = [Math]::Max(350, [Math]::Floor(($maxNodes - $visited) / $scopesLeft))
      $remainingMs = [Math]::Max(50, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
      $scopeDeadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(50, $remainingMs / $scopesLeft))
      $scopeVisited = 0
      $scopeCandidateStart = $cands.Count
      $stack = New-Object System.Collections.Generic.Stack[object]
      try { $stack.Push($scopes[$scopeIndex].GetUpdatedCache($cache)) } catch { continue }
      $minimumProbeNodes = 16
      while ($stack.Count -gt 0 -and $visited -lt $maxNodes -and
             $scopeVisited -lt $scopeNodeBudget -and $cands.Count - $scopeCandidateStart -lt 32 -and
             ($scopeVisited -lt $minimumProbeNodes -or
               ([DateTime]::UtcNow -lt $scopeDeadline -and [DateTime]::UtcNow -lt $deadline))) {
        $el = $stack.Pop()
        $visited++; $scopeVisited++
        $rect = $null
        try { $rect = $el.Cached.BoundingRectangle } catch { continue }
        $rectEmpty = $rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0
        # Prune: a positioned subtree fully outside the search rect can be
        # skipped wholesale (children live inside their parent's rect in
        # practice). Zero/empty rects (unpositioned containers) still descend.
        if (-not $rectEmpty -and -not $rect.IntersectsWith($searchRect)) { continue }
        if (-not $rectEmpty -and $cands.Count -lt 96) {
          try {
            # Size cap: skip window/document-sized containers whose Name is a
            # page/window title, not a clickable element.
            if (-not $el.Cached.IsOffscreen -and $rect.Width -ge 3 -and $rect.Height -ge 3 -and
                $rect.Width -le 2200 -and $rect.Height -le 800) {
              $controlType = ($el.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', '')
              $name = $el.Cached.Name
              if ([string]::IsNullOrWhiteSpace($name)) { $name = $el.Cached.HelpText }
              # Window titles are traversal scopes, not pointing targets. A
              # partial label/title match would otherwise snap to the center
              # of the whole window before its named child control.
              if ($controlType -ne 'Window' -and -not [string]::IsNullOrWhiteSpace($name)) {
                $cands.Add(@{
                  name = $name.Trim()
                  ct = $controlType
                  x = [Math]::Round($rect.X); y = [Math]::Round($rect.Y)
                  w = [Math]::Round($rect.Width); h = [Math]::Round($rect.Height)
                  windowRank = $scopeIndex
                })
              }
            }
          } catch { }
        }
        try {
          $child = $walker.GetFirstChild($el, $cache)
          $n = 0
          while ($null -ne $child -and $n -lt 256) {
            $stack.Push($child); $n++
            $child = $walker.GetNextSibling($child, $cache)
          }
        } catch { }
      }
    }
  }

  # Nearest-first, capped payload (selection happens TS-side).
  $sorted = @($cands | Sort-Object {
      $cx = $_.x + $_.w / 2.0; $cy = $_.y + $_.h / 2.0
      [Math]::Sqrt(($cx - $x) * ($cx - $x) + ($cy - $y) * ($cy - $y))
    } | Select-Object -First 64)

  return @{
    id = $req.id
    elapsedMs = [int]$sw.ElapsedMilliseconds
    from = $from
    visited = $visited
    candidates = $sorted
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  if ($null -eq $req) { continue }
  $resp = $null
  try { $resp = Handle-Request $req } catch {
    $resp = @{ id = $req.id; error = ('' + $_.Exception.Message); candidates = @(); elapsedMs = 0 }
  }
  try {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $resp -Compress -Depth 6))
    [Console]::Out.Flush()
  } catch { }
}
