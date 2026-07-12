# capture-real.ps1 — DPI-aware capture of the primary display at physical
# resolution, downscaled to 2048px longest edge (matching the app's
# CAPTURE_MAX_EDGE) and saved as images/real-plain.jpg (q90).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System.Runtime.InteropServices;
public class DpiAware {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[DpiAware]::SetProcessDPIAware() | Out-Null

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output "physical primary bounds: $($bounds.Width)x$($bounds.Height)"

$raw = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($raw)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()

# downscale to 2048 longest edge (high-quality bicubic)
$scale = 2048.0 / [Math]::Max($bounds.Width, $bounds.Height)
$outW = [int][Math]::Round($bounds.Width * $scale)
$outH = [int][Math]::Round($bounds.Height * $scale)
$small = New-Object System.Drawing.Bitmap($outW, $outH)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($raw, 0, 0, $outW, $outH)
$g2.Dispose()

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]90)
$out = Join-Path $root 'images\real-plain.jpg'
$small.Save($out, $jpegCodec, $encParams)
Write-Output "wrote $out ($outW x $outH, scale $scale)"
$raw.Dispose(); $small.Dispose()
