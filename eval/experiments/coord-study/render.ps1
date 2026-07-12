# render.ps1 — renders the synthetic coord-study test images (exact ground truth)
# from layouts.json via System.Drawing. Variants per layout: plain, grid100,
# ruler, fiducials. Output: images/<layout>-<variant>.jpg (2048x1152, q90).
# Can also composite the same overlays onto an arbitrary source image:
#   -Overlay <src.jpg> <outPrefix>   (renders <outPrefix>-grid100.jpg etc.)
param(
  [string]$OverlaySrc = "",
  [string]$OverlayPrefix = ""
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$spec = Get-Content (Join-Path $root 'layouts.json') -Raw | ConvertFrom-Json
$W = $spec.width; $H = $spec.height
$imgDir = Join-Path $root 'images'
if (-not (Test-Path $imgDir)) { New-Item -ItemType Directory $imgDir | Out-Null }

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]90)

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Base([System.Drawing.Graphics]$g, $targets) {
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#F3F4F6'))
  # faint content texture so the scene is not a void: a few very light panels
  $panelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#E9EBEF'))
  $g.FillRectangle($panelBrush, 60, 180, 560, 260)
  $g.FillRectangle($panelBrush, 1300, 700, 620, 320)
  $panelBrush.Dispose()
  $btnFont = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  foreach ($t in $targets) {
    $col = [System.Drawing.ColorTranslator]::FromHtml($t.color)
    $brush = New-Object System.Drawing.SolidBrush($col)
    if ($t.kind -eq 'button') {
      $x = $t.cx - $t.w / 2; $y = $t.cy - $t.h / 2
      $path = New-RoundedRectPath $x $y $t.w $t.h 8
      $g.FillPath($brush, $path)
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 0, 0, 0), 1.5)
      $g.DrawPath($pen, $path)
      $rect = New-Object System.Drawing.RectangleF($x, $y, $t.w, $t.h)
      $white = [System.Drawing.Brushes]::White
      $g.DrawString($t.label, $btnFont, $white, $rect, $fmt)
      $pen.Dispose(); $path.Dispose()
    } elseif ($t.kind -eq 'dot') {
      $g.FillEllipse($brush, $t.cx - $t.w / 2, $t.cy - $t.h / 2, $t.w, $t.h)
    } elseif ($t.kind -eq 'square') {
      $g.FillRectangle($brush, $t.cx - $t.w / 2, $t.cy - $t.h / 2, $t.w, $t.h)
    }
    $brush.Dispose()
  }
  $btnFont.Dispose(); $fmt.Dispose()
}

function Draw-Grid100([System.Drawing.Graphics]$g) {
  $g.SmoothingMode = 'None'
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(48, 30, 30, 30), 1)
  for ($x = 100; $x -lt $W; $x += 100) { $g.DrawLine($pen, $x, 0, $x, $H) }
  for ($y = 100; $y -lt $H; $y += 100) { $g.DrawLine($pen, 0, $y, $W, $y) }
  $pen.Dispose()
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $font = New-Object System.Drawing.Font('Consolas', 16, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(170, 120, 20, 20))
  for ($x = 200; $x -lt $W; $x += 200) { $g.DrawString("$x", $font, $brush, $x + 2, 2) }
  for ($y = 200; $y -lt $H; $y += 200) { $g.DrawString("$y", $font, $brush, 2, $y + 1) }
  $font.Dispose(); $brush.Dispose()
}

function Draw-Ruler([System.Drawing.Graphics]$g) {
  $g.SmoothingMode = 'None'
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 60, 60, 60), 1)
  # ticks: minor every 50 (6px), major every 100 (12px), on all 4 edges
  for ($x = 50; $x -lt $W; $x += 50) {
    $len = if ($x % 100 -eq 0) { 12 } else { 6 }
    $g.DrawLine($pen, $x, 0, $x, $len)
    $g.DrawLine($pen, $x, $H - $len, $x, $H)
  }
  for ($y = 50; $y -lt $H; $y += 50) {
    $len = if ($y % 100 -eq 0) { 12 } else { 6 }
    $g.DrawLine($pen, 0, $y, $len, $y)
    $g.DrawLine($pen, $W - $len, $y, $W, $y)
  }
  $pen.Dispose()
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $font = New-Object System.Drawing.Font('Consolas', 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 120, 20, 20))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $yBottom = [float]($H - 30)
  $xRight = [float]($W - 52)
  for ($x = 200; $x -lt $W; $x += 200) {
    $ptTop = New-Object System.Drawing.PointF ([float]$x), ([float]13)
    $ptBot = New-Object System.Drawing.PointF ([float]$x), $yBottom
    $g.DrawString("$x", $font, $brush, $ptTop, $fmt)
    $g.DrawString("$x", $font, $brush, $ptBot, $fmt)
  }
  for ($y = 200; $y -lt $H; $y += 200) {
    $yText = [float]($y - 8)
    $g.DrawString("$y", $font, $brush, ([float]14), $yText)
    $g.DrawString("$y", $font, $brush, $xRight, $yText)
  }
  $font.Dispose(); $brush.Dispose(); $fmt.Dispose()
}

function Draw-Fiducials([System.Drawing.Graphics]$g, $fiducials) {
  $g.SmoothingMode = 'None'
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 180, 20, 20), 2)
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $font = New-Object System.Drawing.Font('Consolas', 16, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 150, 15, 15))
  foreach ($f in $fiducials) {
    $x = $f[0]; $y = $f[1]
    $g.DrawLine($pen, $x - 12, $y, $x + 12, $y)
    $g.DrawLine($pen, $x, $y - 12, $x, $y + 12)
    $g.DrawString("($x,$y)", $font, $brush, $x + 8, $y + 6)
  }
  $pen.Dispose(); $font.Dispose(); $brush.Dispose()
}

function Save-Jpeg([System.Drawing.Bitmap]$bmp, [string]$path) {
  $bmp.Save($path, $jpegCodec, $encParams)
  Write-Output "wrote $path"
}

if ($OverlaySrc -ne "") {
  # composite overlays onto an existing image (e.g. the real screenshot)
  $src = [System.Drawing.Image]::FromFile($OverlaySrc)
  foreach ($variant in @('grid100', 'ruler', 'fiducials')) {
    $bmp = New-Object System.Drawing.Bitmap($src.Width, $src.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
    switch ($variant) {
      'grid100'   { Draw-Grid100 $g }
      'ruler'     { Draw-Ruler $g }
      'fiducials' { Draw-Fiducials $g $spec.fiducials }
    }
    $g.Dispose()
    Save-Jpeg $bmp (Join-Path $imgDir "$OverlayPrefix-$variant.jpg")
    $bmp.Dispose()
  }
  $src.Dispose()
  exit 0
}

foreach ($layoutName in @('A', 'B')) {
  $targets = $spec.layouts.$layoutName.targets
  foreach ($variant in @('plain', 'grid100', 'ruler', 'fiducials')) {
    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    Draw-Base $g $targets
    switch ($variant) {
      'grid100'   { Draw-Grid100 $g }
      'ruler'     { Draw-Ruler $g }
      'fiducials' { Draw-Fiducials $g $spec.fiducials }
    }
    $g.Dispose()
    Save-Jpeg $bmp (Join-Path $imgDir "$layoutName-$variant.jpg")
    $bmp.Dispose()
  }
}
