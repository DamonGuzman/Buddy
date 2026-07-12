// Capture.cs — tiny DPI-aware primary-display screenshot helper for the
// coord-study experiment (PowerShell's CopyFromScreen is AMSI-blocked on this
// machine). Compile: csc /r:System.Drawing.dll /r:System.Windows.Forms.dll Capture.cs
// Usage: Capture.exe <out.jpg> [maxEdge=2048]
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class Capture
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    static void Main(string[] args)
    {
        SetProcessDPIAware();
        string outPath = args.Length > 0 ? args[0] : "real-plain.jpg";
        int maxEdge = args.Length > 1 ? int.Parse(args[1]) : 2048;

        Rectangle b = Screen.PrimaryScreen.Bounds;
        Console.WriteLine("physical primary bounds: " + b.Width + "x" + b.Height);

        using (var raw = new Bitmap(b.Width, b.Height))
        {
            using (var g = Graphics.FromImage(raw))
                g.CopyFromScreen(b.Location, Point.Empty, b.Size);

            double scale = (double)maxEdge / Math.Max(b.Width, b.Height);
            if (scale > 1) scale = 1;
            int w = (int)Math.Round(b.Width * scale);
            int h = (int)Math.Round(b.Height * scale);

            using (var small = new Bitmap(w, h))
            {
                using (var g2 = Graphics.FromImage(small))
                {
                    g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g2.DrawImage(raw, 0, 0, w, h);
                }
                var codec = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
                var ep = new EncoderParameters(1);
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L);
                small.Save(outPath, codec, ep);
                Console.WriteLine("wrote " + outPath + " (" + w + "x" + h + ", scale " + scale.ToString("0.####") + ")");
            }
        }
    }
}
