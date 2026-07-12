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
# Clicky's WS_EX_TRANSPARENT click-through overlays) -> GA_ROOT top-level
# window -> AutomationElement.FromHandle -> DFS its descendants with a
# bounding-rect prune (subtrees outside the search radius are skipped) under
# a node/time budget. A CacheRequest batches the properties we read per
# element into one cross-process call. UIA's own FromPoint hits the overlay
# (it ignores hit-test transparency), and root-children z-scans return
# windows in unspecified order — both were tried and picked wrong windows.
# Elements of the excluded pid (Clicky itself) are never used as the scope.

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ClickySnapWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
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

  # --- scope: the top-level window under the point (mouse hit-test) ---
  $scope = $null; $from = $null
  try {
    $wp = New-Object ClickySnapWin32+POINT
    $wp.X = [int][Math]::Round($x); $wp.Y = [int][Math]::Round($y)
    $hwnd = [ClickySnapWin32]::WindowFromPoint($wp)
    if ($hwnd -ne [IntPtr]::Zero) {
      $rootHwnd = [ClickySnapWin32]::GetAncestor($hwnd, 2) # GA_ROOT
      if ($rootHwnd -eq [IntPtr]::Zero) { $rootHwnd = $hwnd }
      [uint32]$wpid = 0
      [void][ClickySnapWin32]::GetWindowThreadProcessId($rootHwnd, [ref]$wpid)
      if ($excludePid -lt 0 -or $wpid -ne $excludePid) {
        $scope = $AE::FromHandle($rootHwnd)
        $from = 'windowfrompoint'
      }
    }
  } catch { }
  if ($null -eq $scope) {
    # Fallback: UIA's own hit test (can land on windows WindowFromPoint
    # skips, e.g. when the point sits on a disabled control).
    try {
      $hit = $AE::FromPoint($pt)
      if ($null -ne $hit -and ($excludePid -lt 0 -or $hit.Current.ProcessId -ne $excludePid)) {
        $scope = Get-TopWindow $hit
        $from = 'frompoint'
      }
    } catch { }
  }

  # --- DFS with rect pruning under node/time budgets ---
  $cands = New-Object System.Collections.Generic.List[object]
  $visited = 0
  if ($null -ne $scope) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($budgetMs)
    $stack = New-Object System.Collections.Generic.Stack[object]
    try { $stack.Push($scope.GetUpdatedCache($cache)) } catch { }
    while ($stack.Count -gt 0 -and $visited -lt $maxNodes -and [DateTime]::UtcNow -lt $deadline) {
      $el = $stack.Pop()
      $visited++
      $rect = $null
      try { $rect = $el.Cached.BoundingRectangle } catch { continue }
      $rectEmpty = $rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0
      # Prune: a positioned subtree fully outside the search rect can be
      # skipped wholesale (children live inside their parent's rect in
      # practice). Zero/empty rects (unpositioned containers) still descend.
      if (-not $rectEmpty -and -not $rect.IntersectsWith($searchRect)) { continue }
      if (-not $rectEmpty -and $cands.Count -lt 64) {
        try {
          # Size cap: skip window/document-sized containers whose Name is a
          # page/window title, not a clickable element.
          if (-not $el.Cached.IsOffscreen -and $rect.Width -le 2200 -and $rect.Height -le 800) {
            $name = $el.Cached.Name
            if ([string]::IsNullOrWhiteSpace($name)) { $name = $el.Cached.HelpText }
            if (-not [string]::IsNullOrWhiteSpace($name)) {
              $cands.Add(@{
                name = $name.Trim()
                ct = ($el.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', '')
                x = [Math]::Round($rect.X); y = [Math]::Round($rect.Y)
                w = [Math]::Round($rect.Width); h = [Math]::Round($rect.Height)
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

  # Nearest-first, capped payload (selection happens TS-side).
  $sorted = @($cands | Sort-Object {
      $cx = $_.x + $_.w / 2.0; $cy = $_.y + $_.h / 2.0
      [Math]::Sqrt(($cx - $x) * ($cx - $x) + ($cy - $y) * ($cy - $y))
    } | Select-Object -First 32)

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
