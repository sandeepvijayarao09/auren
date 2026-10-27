// How each event reads on a small screen: a signal, a word, an SF Symbol and one line.
// The words and signals follow brand/README.md; color is never the only cue.
import Foundation

public enum Signal: Sendable, Equatable {
    /// Waiting for your tap. The only gold state.
    case you
    case done, stopped, proof, read, neutral
}

public struct EventStyle: Sendable, Equatable {
    public let signal: Signal
    public let word: String
    public let symbol: String
}

public extension AurenEvent {
    var style: EventStyle {
        switch kind {
        case .receipt: EventStyle(signal: .done, word: "Done", symbol: "checkmark.circle.fill")
        case .approval:
            string("status") == "requested"
                ? EventStyle(signal: .you, word: "Your move", symbol: "hand.tap.fill")
                : EventStyle(signal: .neutral, word: "Approval", symbol: "hand.tap")
        case .error: EventStyle(signal: .stopped, word: "Stopped", symbol: "stop.fill")
        case .toolCall: EventStyle(signal: .read, word: string("tier") == "read" ? "Read" : "Working", symbol: "circle.dotted")
        case .utterance: EventStyle(signal: .neutral, word: "You", symbol: "waveform")
        case .ack, .reply: EventStyle(signal: .neutral, word: "Muse", symbol: "text.bubble")
        case .handoff: EventStyle(signal: .read, word: "Moved", symbol: "arrow.left.arrow.right")
        case .surface: EventStyle(signal: .read, word: "Device", symbol: "dot.radiowaves.left.and.right")
        case .unknown: EventStyle(signal: .read, word: "Event", symbol: "circle")
        }
    }

    /// One line of text, matching the web console's timeline.
    var line: String {
        switch kind {
        case .utterance: "“\(string("text") ?? "")”"
        case .ack, .reply: string("text") ?? ""
        case .toolCall: "\(string("app") ?? "") · \(string("tool") ?? "")"
        case .receipt: string("summary") ?? ""
        case .approval: [string("status"), string("summary")].compactMap { $0 }.joined(separator: ": ")
        case .handoff: "Approval moved from \(string("from") ?? "?") to \(string("to") ?? "nowhere yet")"
        case .error: string("message") ?? ""
        case .surface: "\(string("kind") ?? "") \(string("status") ?? "")"
        case .unknown: ""
        }
    }
}
