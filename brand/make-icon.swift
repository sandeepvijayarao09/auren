// Draws the Auren app icon: the mark in Aurum on Onyx, as an opaque PNG.
// Usage: swift brand/make-icon.swift <out.png> [size]
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("usage: swift make-icon.swift <out.png> [size]")
    exit(1)
}
let size = args.count > 2 ? Int(args[2]) ?? 1024 : 1024
let side = CGFloat(size)

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha)
}

guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!,
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(1) }
ctx.setFillColor(rgb(0x0B0B0C))
ctx.fill(CGRect(x: 0, y: 0, width: side, height: side))

// The mark lives on a 22-unit grid (brand/mark.svg); it fills 62% of the icon.
let unit = side * 0.62 / 22
let center = CGPoint(x: side / 2, y: side / 2)
ctx.setLineWidth(1.2 * unit)
for (radius, alpha) in [(10.0, 0.35), (7.0, 0.6), (4.0, 1.0)] {
    let r = radius * unit
    ctx.setStrokeColor(rgb(0xD4AB54, alpha))
    ctx.strokeEllipse(in: CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r))
}
let dot = 1.6 * unit
ctx.setFillColor(rgb(0xD4AB54))
ctx.fillEllipse(in: CGRect(x: center.x - dot, y: center.y - dot, width: 2 * dot, height: 2 * dot))

guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL,
                                                 UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, image, nil)
exit(CGImageDestinationFinalize(dest) ? 0 : 1)
