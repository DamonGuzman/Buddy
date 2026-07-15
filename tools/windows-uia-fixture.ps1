# Native Windows UIA fixture for tests/windows-uia-e2e.test.ts.
#
# Two real WPF windows are placed side by side. The query point is inside the
# left window while the uniquely named target is in the right window, proving
# Buddy enumerates the visible window scene instead of only the point window.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

function New-FixtureWindow($title, $left, $buttonName, $automationId) {
  $window = New-Object System.Windows.Window
  $window.Title = $title
  $window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
  $window.Left = $left
  $window.Top = 120
  $window.Width = 420
  $window.Height = 360
  $window.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $window.ShowInTaskbar = $true
  $window.Topmost = $true

  $panel = New-Object System.Windows.Controls.Grid
  $panel.Background = [System.Windows.Media.Brushes]::White
  $button = New-Object System.Windows.Controls.Button
  $button.Content = $buttonName
  $button.Name = $automationId
  $button.Width = 220
  $button.Height = 56
  $button.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
  $button.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
  [System.Windows.Automation.AutomationProperties]::SetName($button, $buttonName)
  [void]$panel.Children.Add($button)
  $window.Content = $panel

  return @{ window = $window; button = $button }
}

$left = New-FixtureWindow 'Buddy UIA point window' 80 'Unrelated control' 'UnrelatedControl'
$right = New-FixtureWindow 'Secondary fixture window' 560 'Buddy Adjacent Target' 'BuddyAdjacentTarget'

[void]$left.window.Show()
[void]$right.window.Show()
[void]$left.window.Activate()
[System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke(
  [System.Windows.Threading.DispatcherPriority]::ApplicationIdle,
  [Action]{ }
)
# WPF can report Loaded before its provider has published the complete UIA
# subtree. Let one rendered frame and provider notification settle before the
# test starts the production daemon; this is fixture readiness, not a retry.
[System.Threading.Thread]::Sleep(500)
[System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke(
  [System.Windows.Threading.DispatcherPriority]::ApplicationIdle,
  [Action]{ }
)

$targetOrigin = $right.button.PointToScreen((New-Object System.Windows.Point(0, 0)))
$pointOrigin = $left.button.PointToScreen((New-Object System.Windows.Point(0, 0)))
$ready = @{
  fixturePid = $PID
  query = @{
    x = [Math]::Round($pointOrigin.X + ($left.button.ActualWidth / 2.0))
    y = [Math]::Round($pointOrigin.Y + ($left.button.ActualHeight / 2.0))
  }
  target = @{
    x = [Math]::Round($targetOrigin.X + ($right.button.ActualWidth / 2.0))
    y = [Math]::Round($targetOrigin.Y + ($right.button.ActualHeight / 2.0))
  }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $ready -Compress -Depth 4))
[Console]::Out.Flush()

[System.Windows.Threading.Dispatcher]::Run()
