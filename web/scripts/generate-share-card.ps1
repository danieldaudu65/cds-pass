$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$width = 1200
$height = 630
$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function Draw-RoundedRect($graphics, [System.Drawing.RectangleF]$rect, [single]$radius, $brush, $pen = $null) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  if ($brush) { $graphics.FillPath($brush, $path) }
  if ($pen) { $graphics.DrawPath($pen, $path) }
  $path.Dispose()
}

$background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(0, 0, $width, $height),
  [System.Drawing.Color]::FromArgb(5, 37, 23),
  [System.Drawing.Color]::FromArgb(8, 91, 49), 35
)
$graphics.FillRectangle($background, 0, 0, $width, $height)
$background.Dispose()

# Fine grid and glow pools echo the animated landing hero.
$gridPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(17, 205, 246, 215), 1)
for ($x = 0; $x -lt $width; $x += 42) { $graphics.DrawLine($gridPen, $x, 0, $x, $height) }
for ($y = 0; $y -lt $height; $y += 42) { $graphics.DrawLine($gridPen, 0, $y, $width, $y) }
$gridPen.Dispose()
foreach ($glow in @(@(920, 270, 330, 330, 46, 32, 170, 80), @(210, 540, 390, 220, 30, 14, 109, 64))) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddEllipse([single]$glow[0], [single]$glow[1], [single]$glow[2], [single]$glow[3])
  $brush = [System.Drawing.Drawing2D.PathGradientBrush]::new($path)
  $brush.CenterColor = [System.Drawing.Color]::FromArgb([int]$glow[4], [int]$glow[5], [int]$glow[6], [int]$glow[7])
  $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $graphics.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
}

$lime = [System.Drawing.Color]::FromArgb(14, 220, 92)
$gold = [System.Drawing.Color]::FromArgb(201, 183, 131)
$white = [System.Drawing.Color]::White
$mint = [System.Drawing.Color]::FromArgb(198, 232, 211)

# Brand lockup.
$iconBrush = [System.Drawing.SolidBrush]::new($lime)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(84, 58, 44, 44)) 12 $iconBrush
$iconBrush.Dispose()
$checkPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(5, 52, 29), 4)
$checkPen.StartCap = 'Round'
$checkPen.EndCap = 'Round'
$checkPoints = [System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(96, 80),
  [System.Drawing.Point]::new(103, 87),
  [System.Drawing.Point]::new(117, 69)
)
$graphics.DrawLines($checkPen, $checkPoints)
$checkPen.Dispose()
$fontBrand = [System.Drawing.Font]::new('Segoe UI', 22, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brandBrush = [System.Drawing.SolidBrush]::new($white)
$graphics.DrawString('CDS PASS', $fontBrand, $brandBrush, 142, 62)
[System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(170, 201, 183, 131), 3) | ForEach-Object { $graphics.DrawLine($_, 84, 119, 166, 119); $_.Dispose() }

# Headline and supporting copy.
$headline = [System.Drawing.Font]::new('Segoe UI', 54, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$headlineAccent = [System.Drawing.Font]::new('Segoe UI', 61, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$bodyFont = [System.Drawing.Font]::new('Segoe UI', 23, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$smallBold = [System.Drawing.Font]::new('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$whiteBrush = [System.Drawing.SolidBrush]::new($white)
$limeBrush = [System.Drawing.SolidBrush]::new($lime)
$mintBrush = [System.Drawing.SolidBrush]::new($mint)
$goldBrush = [System.Drawing.SolidBrush]::new($gold)
$graphics.DrawString('No more queueing', $headline, $whiteBrush, 82, 170)
$graphics.DrawString('for CDS numbers.', $headlineAccent, $limeBrush, 82, 235)
$graphics.DrawString('Check in. Get your number.', $bodyFont, $mintBrush, 86, 336)
$graphics.DrawString("Know when it's your turn to thumbprint.", $bodyFont, $mintBrush, 86, 372)
$chipBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(35, 255, 255, 255))
$chipPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(60, 255, 255, 255), 1)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(84, 445, 318, 44)) 18 $chipBrush $chipPen
$graphics.DrawString('A simpler, fairer CDS check-in', $smallBold, $goldBrush, 103, 457)

# Floating 3D tag: thick edge, tilted face, layered card, and lanyard clip.
$state = $graphics.Save()
$graphics.TranslateTransform(935, 309)
$graphics.RotateTransform(-5)
$graphics.TranslateTransform(-935, -309)
$shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(95, 0, 0, 0))
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(756, 111, 366, 468)) 34 $shadowBrush
$shadowBrush.Dispose()
$edgeBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(1059, 93, 42, 484),
  [System.Drawing.Color]::FromArgb(4, 55, 29), [System.Drawing.Color]::FromArgb(2, 25, 14), 0
)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(760, 103, 366, 466)) 34 $edgeBrush
$edgeBrush.Dispose()
$cardBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(736, 83, 365, 466),
  [System.Drawing.Color]::FromArgb(16, 139, 76), [System.Drawing.Color]::FromArgb(3, 66, 36), 42
)
$cardPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(100, 215, 255, 228), 2)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(738, 84, 365, 466)) 34 $cardBrush $cardPen
$cardBrush.Dispose()
$cardPen.Dispose()
$panelBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(770, 139, 302, 373),
  [System.Drawing.Color]::FromArgb(250, 253, 248), [System.Drawing.Color]::FromArgb(222, 240, 228), 55
)
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(770, 139, 302, 373)) 23 $panelBrush
$panelBrush.Dispose()
$tagFont = [System.Drawing.Font]::new('Segoe UI', 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$tinyFont = [System.Drawing.Font]::new('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$numberFont = [System.Drawing.Font]::new('Segoe UI', 116, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$turnFont = [System.Drawing.Font]::new('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$darkBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(5, 48, 27))
$greenBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(9, 112, 58))
$mutedBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(75, 103, 84))
$graphics.DrawString('CDS PASS', $tagFont, $darkBrush, 797, 158)
$badgeBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(218, 238, 224))
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(965, 154, 87, 30)) 14 $badgeBrush
$graphics.DrawString('CDS TAG', $tinyFont, $greenBrush, 979, 162)
$separatorPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(100, 11, 107, 58), 2)
$graphics.DrawLine($separatorPen, 798, 204, 1045, 204)
$separatorPen.Dispose()
$graphics.DrawString('YOUR NUMBER', $tinyFont, $mutedBrush, 839, 236)
# Raised number shadow, then face.
$numberShadow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(70, 3, 55, 29))
$graphics.DrawString('14', $numberFont, $numberShadow, 831, 268)
$graphics.DrawString('14', $numberFont, $greenBrush, 824, 253)
$numberShadow.Dispose()
$turnBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(9, 112, 58))
Draw-RoundedRect $graphics ([System.Drawing.RectangleF]::new(797, 421, 249, 57)) 17 $turnBrush
$graphics.DrawString("YOU'RE UP NEXT", $turnFont, $whiteBrush, 842, 439)
$graphics.DrawString('SCAN IN  |  GET CALLED  |  THUMBPRINT', $tinyFont, $mintBrush, 790, 522)
$clipPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(238, 201, 183, 131), 9)
$graphics.DrawArc($clipPen, 879, 48, 78, 96, 190, 160)
$graphics.DrawLine($clipPen, 897, 104, 897, 128)
$graphics.DrawLine($clipPen, 939, 104, 939, 128)
$clipPen.Dispose()
$graphics.Restore($state)

# Floating polished orbs mirror the landing hero.
foreach ($orb in @(@(1112, 160, 32, 32, 14, 220, 92), @(694, 494, 26, 26, 201, 183, 131), @(1115, 445, 20, 20, 213, 241, 223))) {
  $rect = [System.Drawing.Rectangle]::new([int]$orb[0], [int]$orb[1], [int]$orb[2], [int]$orb[3])
  $orbBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $rect,
    [System.Drawing.Color]::FromArgb(245, [int]$orb[4], [int]$orb[5], [int]$orb[6]),
    [System.Drawing.Color]::FromArgb(100, 5, 48, 27), 45
  )
  $graphics.FillEllipse($orbBrush, $rect)
  $orbBrush.Dispose()
  $highlight = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(110, 255, 255, 255))
  $graphics.FillEllipse($highlight, $rect.X + 5, $rect.Y + 4, 7, 7)
  $highlight.Dispose()
}

# The simple journey remains readable in WhatsApp's small preview.
$graphics.DrawString('SCAN IN', $smallBold, $mintBrush, 86, 548)
$graphics.DrawString('>', $smallBold, $goldBrush, 169, 546)
$graphics.DrawString('GET YOUR NUMBER', $smallBold, $mintBrush, 198, 548)
$graphics.DrawString('>', $smallBold, $goldBrush, 374, 546)
$graphics.DrawString('THUMBPRINT ON TIME', $smallBold, $mintBrush, 402, 548)

$output = Join-Path (Get-Location) 'web/public/share-card-3d.png'
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "Wrote $output at 1200x630."
