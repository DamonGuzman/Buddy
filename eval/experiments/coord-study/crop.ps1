# crop.ps1 — cut 1:1 regions out of images/real-plain.jpg for ground-truth
# pixel inspection. Usage: crop.ps1 -X 660 -Y 1090 -W 120 -H 62 -Out start.png
param(
  [int]$X, [int]$Y, [int]$W, [int]$H,
  [string]$Out,
  [string]$Src = "images\real-plain.jpg"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$img = [System.Drawing.Image]::FromFile((Join-Path $root $Src))
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$srcRect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$outPath = Join-Path $root $Out
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $img.Dispose()
Write-Output "wrote $outPath (src $X,$Y ${W}x$H)"
