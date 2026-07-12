# mark.ps1 — draw crosshairs at claimed global centers onto crops of
# images/real-plain.jpg to visually verify hand-derived ground truth.
# Usage: mark.ps1 -Points "706,1130;2010,1127" -Out crops\verify.png
param(
  [string]$Points,
  [string]$Out,
  [int]$Pad = 60,
  [string]$Src = "images\real-plain.jpg"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$img = [System.Drawing.Image]::FromFile((Join-Path $root $Src))
$pts = $Points -split ';' | ForEach-Object { $p = $_ -split ','; ,@([int]$p[0], [int]$p[1]) }
$i = 0
foreach ($pt in $pts) {
  $cx = $pt[0]; $cy = $pt[1]
  $x0 = [Math]::Max(0, $cx - $Pad); $y0 = [Math]::Max(0, $cy - $Pad)
  $w = [Math]::Min($img.Width - $x0, 2 * $Pad); $h = [Math]::Min($img.Height - $y0, 2 * $Pad)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dst = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $srcR = New-Object System.Drawing.Rectangle($x0, $y0, $w, $h)
  $g.DrawImage($img, $dst, $srcR, [System.Drawing.GraphicsUnit]::Pixel)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Magenta, 1)
  $mx = $cx - $x0; $my = $cy - $y0
  $g.DrawLine($pen, $mx - 14, $my, $mx + 14, $my)
  $g.DrawLine($pen, $mx, $my - 14, $mx, $my + 14)
  $g.Dispose(); $pen.Dispose()
  $outPath = Join-Path $root ($Out -replace '\.png$', "-$i.png")
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "wrote $outPath (center $cx,$cy)"
  $i++
}
$img.Dispose()
