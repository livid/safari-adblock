// Draws the background of the release disk image: the name and version, an arrow from the
// app to the Applications folder, and a line saying to drag it there. Used by release.sh.
//
//   swift tools/dmg-background.swift <version> <out.png> <scale>
//
// The picture is 660 × 420 points. tools/dmg-settings.py places the two icons on it, at
// `appCenter` and `applicationsCenter` below (measured from the top left, as Finder does).

import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 4, let scale = Double(arguments[3]) else {
    FileHandle.standardError.write(Data("usage: dmg-background.swift <version> <out.png> <scale>\n".utf8))
    exit(2)
}
let version = arguments[1]
let output = URL(fileURLWithPath: arguments[2])

let size = CGSize(width: 660, height: 420)
let appCenter = CGPoint(x: 175, y: 218)
let applicationsCenter = CGPoint(x: 485, y: 218)

let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
bitmap.size = size // points; the pixel size above sets the scale
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let context = NSGraphicsContext.current!.cgContext

/// Finder measures from the top; Core Graphics from the bottom.
func fromTop(_ y: CGFloat) -> CGFloat { size.height - y }
func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

// Blue like the shield in the icon. Mid-toned on purpose: Finder draws the icon names in
// black in light mode and white in dark mode, and both have to be readable on it.
NSGradient(colors: [color(0x7AA7F8), color(0x4F83EE), color(0x3C6FE2)], atLocations: [0, 0.55, 1], colorSpace: .sRGB)!
    .draw(in: CGRect(origin: .zero, size: size), angle: -90)
// A soft light from the top.
NSGradient(starting: color(0xFFFFFF, 0.28), ending: color(0xFFFFFF, 0))!
    .draw(fromCenter: CGPoint(x: size.width / 2, y: size.height + 40), radius: 0,
          toCenter: CGPoint(x: size.width / 2, y: size.height + 40), radius: 420, options: [])

// A lighter plate under each icon and its name.
for center in [appCenter, applicationsCenter] {
    let plate = CGRect(x: center.x - 92, y: fromTop(center.y + 108), width: 184, height: 196)
    color(0xFFFFFF, 0.14).setFill()
    NSBezierPath(roundedRect: plate, xRadius: 22, yRadius: 22).fill()
    color(0xFFFFFF, 0.22).setStroke()
    let border = NSBezierPath(roundedRect: plate.insetBy(dx: 0.5, dy: 0.5), xRadius: 22, yRadius: 22)
    border.lineWidth = 1
    border.stroke()
}

// The arrow between them.
let arrowY = fromTop(appCenter.y + 6)
let (arrowStart, arrowEnd) = (appCenter.x + 112, applicationsCenter.x - 112)
let arrow = NSBezierPath()
arrow.move(to: CGPoint(x: arrowStart, y: arrowY))
arrow.line(to: CGPoint(x: arrowEnd, y: arrowY))
arrow.move(to: CGPoint(x: arrowEnd - 16, y: arrowY + 14))
arrow.line(to: CGPoint(x: arrowEnd, y: arrowY))
arrow.line(to: CGPoint(x: arrowEnd - 16, y: arrowY - 14))
arrow.lineWidth = 5
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
color(0xFFFFFF, 0.92).setStroke()
arrow.stroke()

func draw(_ text: String, font: NSFont, alpha: CGFloat, centeredAtTop y: CGFloat) {
    let shadow = NSShadow()
    shadow.shadowColor = color(0x1B3A8A, 0.35)
    shadow.shadowOffset = CGSize(width: 0, height: -1)
    shadow.shadowBlurRadius = 3
    let string = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color(0xFFFFFF, alpha), .shadow: shadow])
    let bounds = string.size()
    string.draw(at: CGPoint(x: (size.width - bounds.width) / 2, y: fromTop(y) - bounds.height / 2))
}

draw("Shield for Safari", font: .systemFont(ofSize: 28, weight: .bold), alpha: 1, centeredAtTop: 48)
draw("Version \(version)", font: .systemFont(ofSize: 14, weight: .medium), alpha: 0.85, centeredAtTop: 78)
draw("Drag Shield to the Applications folder to install", font: .systemFont(ofSize: 15, weight: .medium), alpha: 0.95, centeredAtTop: 368)

context.flush()
try bitmap.representation(using: .png, properties: [:])!.write(to: output)
