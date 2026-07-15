$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BuddyProofWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@

$proofs = @{}
$proofLifetimeMs = 2000

function Test-RuntimeId($candidate, $expectedId) {
  try {
    $actual = @($candidate.GetRuntimeId())
    if ($actual.Count -ne $expectedId.Count) { return $false }
    for ($index = 0; $index -lt $actual.Count; $index++) {
      if ([int]$actual[$index] -ne [int]$expectedId[$index]) { return $false }
    }
    return $true
  } catch { return $false }
}

function Get-ExactFocusedElement($identity) {
  $hwnd = [BuddyProofWin32]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero -or $hwnd.ToInt64().ToString() -ne [string]$identity.window.handle) {
    throw 'retained window is not foreground'
  }
  [uint32]$pid = 0
  [void][BuddyProofWin32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
  if ([int]$pid -ne [int]$identity.pid) { throw 'retained window owner changed' }
  $focus = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $focus -or [int]$focus.Current.ProcessId -ne [int]$identity.focus.pid -or
      -not (Test-RuntimeId $focus @($identity.focus.runtimeId))) {
    throw 'retained focused element changed'
  }
  return $focus
}

function Get-TextPattern($focus) {
  try {
    return [System.Windows.Automation.TextPattern]$focus.GetCurrentPattern(
      [System.Windows.Automation.TextPattern]::Pattern
    )
  } catch {
    throw 'focused element does not expose exact text and selection state'
  }
}

function Get-PrefixLength($pattern, $selection) {
  $prefix = $pattern.DocumentRange.Clone()
  $prefix.MoveEndpointByRange(
    [System.Windows.Automation.TextPatternRangeEndpoint]::End,
    $selection,
    [System.Windows.Automation.TextPatternRangeEndpoint]::Start
  )
  return $prefix.GetText(-1).Length
}

function Remove-ExpiredProofs() {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach ($token in @($proofs.Keys)) {
    if ([int64]$proofs[$token].expiresAt -lt $now) { $proofs.Remove($token) }
  }
  while ($proofs.Count -gt 32) {
    $oldest = $proofs.GetEnumerator() | Sort-Object { [int64]$_.Value.createdAt } | Select-Object -First 1
    if ($null -eq $oldest) { break }
    $proofs.Remove([string]$oldest.Key)
  }
}

function Prepare-Proof($identity, [string]$text) {
  if ($text.Length -eq 0) { throw 'empty text cannot produce an input postcondition' }
  if ($text.Length -gt 10000) { throw 'text exceeds proof limit' }
  $focus = Get-ExactFocusedElement $identity
  $pattern = Get-TextPattern $focus
  $selectionItems = @($pattern.GetSelection())
  if ($selectionItems.Count -ne 1) { throw 'focused element selection is ambiguous' }
  $selection = $selectionItems[0]
  $prefix = $pattern.DocumentRange.Clone()
  $prefix.MoveEndpointByRange(
    [System.Windows.Automation.TextPatternRangeEndpoint]::End,
    $selection,
    [System.Windows.Automation.TextPatternRangeEndpoint]::Start
  )
  $suffix = $pattern.DocumentRange.Clone()
  $suffix.MoveEndpointByRange(
    [System.Windows.Automation.TextPatternRangeEndpoint]::Start,
    $selection,
    [System.Windows.Automation.TextPatternRangeEndpoint]::End
  )
  $prefixText = $prefix.GetText(-1)
  $expected = $prefixText + $text + $suffix.GetText(-1)
  $expectedBytes = [Text.Encoding]::UTF8.GetBytes($expected)
  $expectedDigest = [Convert]::ToBase64String(
    [Security.Cryptography.SHA256]::Create().ComputeHash($expectedBytes)
  )
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $token = [Guid]::NewGuid().ToString()
  $proofs[$token] = @{
    identity = $identity
    expectedDigest = $expectedDigest
    expectedLength = $expected.Length
    insertionEnd = $prefixText.Length + $text.Length
    createdAt = $now
    expiresAt = $now + $proofLifetimeMs
  }
  Remove-ExpiredProofs
  return $token
}

function Verify-Proof([string]$token) {
  Remove-ExpiredProofs
  $proof = $proofs[$token]
  if ($null -eq $proof) { return $false }
  try { $focus = Get-ExactFocusedElement $proof.identity } catch {
    $proofs.Remove($token)
    return $false
  }
  try {
    $pattern = Get-TextPattern $focus
    $current = $pattern.DocumentRange.GetText(-1)
    if ($current.Length -ne [int]$proof.expectedLength) { return $false }
    $currentDigest = [Convert]::ToBase64String(
      [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($current))
    )
    if ($currentDigest -cne [string]$proof.expectedDigest) { return $false }
    $selectionItems = @($pattern.GetSelection())
    if ($selectionItems.Count -ne 1) { return $false }
    $selection = $selectionItems[0]
    if ($selection.GetText(-1).Length -ne 0) { return $false }
    if ((Get-PrefixLength $pattern $selection) -ne [int]$proof.insertionEnd) { return $false }
    $proofs.Remove($token)
    return $true
  } catch {
    $proofs.Remove($token)
    return $false
  }
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = 0
  try {
    $request = $line | ConvertFrom-Json
    $id = [int]$request.id
    if ([string]$request.action -eq 'prepare') {
      $token = Prepare-Proof $request.identity ([string]$request.text)
      $reply = @{ id = $id; ok = $true; proofToken = $token }
    } elseif ([string]$request.action -eq 'verify') {
      $reply = @{ id = $id; ok = (Verify-Proof ([string]$request.proofToken)) }
    } else {
      throw 'unknown proof action'
    }
  } catch {
    $reply = @{ id = $id; ok = $false }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
