// Auren brand v1 for SwiftUI. The palette and its rules are in brand/README.md;
// keep this file, brand/tokens.css and the AccentColor assets in step.
import AVFoundation
import SwiftUI

public extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }

    static let aurenOnyx = Color(hex: 0x0B0B0C)
    static let aurenHalo = Color(hex: 0xF4F1EA)
    static let aurenAsh = Color(hex: 0x9A968C)
    static let aurenGraphite = Color(hex: 0x1C1C1E)
    /// The fixed gold of the mark. Buttons use `.accentColor`, which follows the
    /// AccentColor asset (light, dark and increased-contrast variants).
    static let aurenAurum = Color(hex: 0xD4AB54)

    // Signals are system colors, so they adapt to light, dark and Increase Contrast.
    static let aurenDone = Color.green
    static let aurenStopped = Color.red
    static let aurenProof = Color.blue
}

public extension Signal {
    var color: Color {
        switch self {
        case .you: .accentColor
        case .done: .aurenDone
        case .stopped: .aurenStopped
        case .proof: .aurenProof
        case .read: .secondary
        case .neutral: .primary
        }
    }
}

/// The mark: a gold dot for you, inside rings for what you wear, carry and sit at.
/// Same geometry as brand/mark.svg (a 22-unit grid).
public struct AurenMark: View {
    public var size: CGFloat

    public init(size: CGFloat = 22) {
        self.size = size
    }

    public var body: some View {
        ZStack {
            ring(10, opacity: 0.35)
            ring(7, opacity: 0.6)
            ring(4, opacity: 1)
            Circle().fill(Color.aurenAurum).frame(width: 3.2 * unit, height: 3.2 * unit)
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel("Auren")
    }

    private var unit: CGFloat { size / 22 }

    private func ring(_ radius: CGFloat, opacity: Double) -> some View {
        Circle()
            .stroke(Color.aurenAurum.opacity(opacity), lineWidth: 1.2 * unit)
            .frame(width: 2 * radius * unit, height: 2 * radius * unit)
    }
}

/// Speaks Core's `speak` messages with the system voice until Muse voice lands (Day 3).
@MainActor
public final class Speaker {
    private let synthesizer = AVSpeechSynthesizer()

    public init() {}

    public func speak(_ text: String) {
        synthesizer.speak(AVSpeechUtterance(string: text))
    }
}

public enum DeviceID {
    /// A stable id for this install, such as "watch-7f3a", so Core sees the same surface after a restart.
    public static func stable(prefix: String, defaults: UserDefaults = .standard) -> String {
        let key = "auren.surfaceID.\(prefix)"
        if let id = defaults.string(forKey: key) { return id }
        let id = "\(prefix)-\(UUID().uuidString.prefix(4).lowercased())"
        defaults.set(id, forKey: key)
        return id
    }
}
