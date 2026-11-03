// Voice: the microphone streamed to Core's /v1/voice as PCM16 mono at 24 kHz,
// the format Muse Voice Transcribe takes. Core holds the model key; the device
// only proves it's paired and sends audio while you hold to talk.
import AVFoundation
import Foundation

/// Core → device on /v1/voice.
public enum VoiceMessage: Decodable, Sendable, Equatable {
    case challenge(nonce: String)
    case ready
    case transcript(text: String, final: Bool)
    case done(text: String)
    case error(message: String)
    case unknown

    private enum Keys: String, CodingKey { case type, nonce, text, final, message }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "challenge": self = .challenge(nonce: try c.decode(String.self, forKey: .nonce))
        case "ready": self = .ready
        case "transcript": self = .transcript(text: try c.decode(String.self, forKey: .text), final: try c.decodeIfPresent(Bool.self, forKey: .final) ?? false)
        case "done": self = .done(text: try c.decode(String.self, forKey: .text))
        case "error": self = .error(message: try c.decode(String.self, forKey: .message))
        default: self = .unknown
        }
    }
}

public extension DeviceIdentity {
    /// Must match voicePayload in core/src/security/devices.ts. Its own prefix, so a hello signature can't open the microphone.
    static func voicePayload(nonce: String, deviceID: String) -> Data {
        Data("auren-voice\n\(nonce)\n\(deviceID)".utf8)
    }

    func voiceAuth(nonce: String) throws -> HelloAuth {
        HelloAuth(deviceID: deviceID, signature: try sign(Self.voicePayload(nonce: nonce, deviceID: deviceID)).base64EncodedString())
    }
}

/// Converts whatever the microphone gives (often 48 kHz float) to 24 kHz mono PCM16.
public final class PCMConverter: @unchecked Sendable {
    public static let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
    private let converter: AVAudioConverter

    public init?(from input: AVAudioFormat) {
        guard let c = AVAudioConverter(from: input, to: Self.output) else { return nil }
        converter = c
    }

    public func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Self.output.sampleRate / buffer.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: Self.output, frameCapacity: capacity) else { return nil }
        nonisolated(unsafe) let input = buffer
        let fed = Fed()
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed.done {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed.done = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error, let samples = out.int16ChannelData, out.frameLength > 0 else { return nil }
        return Data(bytes: samples[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }

    private final class Fed: @unchecked Sendable { var done = false }
}

/// /v1/voice on the same host as the surface socket.
public func voiceURL(core: URL, token: String?) -> URL? {
    guard var surface = SurfaceClient.socketURL(core: core, token: token), var parts = URLComponents(url: surface, resolvingAgainstBaseURL: false) else { return nil }
    parts.path = "/v1/voice"
    surface = parts.url ?? surface
    return surface
}

#if os(iOS)
/// Hold to talk: opens /v1/voice, proves the device, streams the microphone, shows live words.
@MainActor
@Observable
public final class VoiceSession {
    public enum Phase: Equatable { case idle, connecting, listening, finishing, failed(String) }

    public private(set) var phase: Phase = .idle
    /// What Muse has heard so far; the final text once you let go.
    public private(set) var transcript = ""

    private let client: SurfaceClient
    private let engine = AVAudioEngine()
    private var socket: URLSessionWebSocketTask?
    // Letting go before the channel opens must still stop the microphone once it does.
    private var stopRequested = false

    public init(client: SurfaceClient) {
        self.client = client
    }

    public func start(core: URL, token: String?) async {
        switch phase {
        case .idle, .failed: break
        default: return
        }
        phase = .connecting
        transcript = ""
        stopRequested = false
        guard await AVAudioApplication.requestRecordPermission() else {
            phase = .failed("Allow the microphone for Auren in Settings.")
            return
        }
        guard let url = voiceURL(core: core, token: token) else {
            phase = .failed("The Core address must start with http:// or https://")
            return
        }
        let socket = URLSession.shared.webSocketTask(with: url)
        self.socket = socket
        socket.resume()
        do {
            guard case .challenge(let nonce) = try await next(socket) else { throw PairingError(message: "Core didn't open the voice channel.") }
            var start: [String: Any] = ["type": "start", "surface_id": client.manifest.id]
            if let auth = try client.identity?.voiceAuth(nonce: nonce) {
                start["auth"] = ["device_id": auth.deviceID, "signature": auth.signature]
            }
            try await socket.send(.string(String(decoding: try JSONSerialization.data(withJSONObject: start), as: UTF8.self)))
            switch try await next(socket) {
            case .ready: break
            case .error(let message): throw PairingError(message: message)
            default: throw PairingError(message: "Core didn't start listening.")
            }
            try startMicrophone(sendingTo: socket)
            phase = .listening
            Task { await listen(socket) }
            if stopRequested { await stop() }
        } catch {
            stopMicrophone()
            socket.cancel(with: .goingAway, reason: nil)
            phase = .failed(error.localizedDescription)
        }
    }

    /// Let go: stop the microphone and wait for the final words. Core runs the command.
    public func stop() async {
        if phase == .connecting {
            stopRequested = true
            return
        }
        guard phase == .listening, let socket else { return }
        stopMicrophone()
        phase = .finishing
        try? await socket.send(.string(#"{"type":"end"}"#))
    }

    private func next(_ socket: URLSessionWebSocketTask) async throws -> VoiceMessage {
        guard case .string(let text) = try await socket.receive() else { return .unknown }
        return try JSONDecoder().decode(VoiceMessage.self, from: Data(text.utf8))
    }

    private func listen(_ socket: URLSessionWebSocketTask) async {
        while true {
            guard let message = try? await next(socket) else { break }
            switch message {
            case .transcript(let text, _): transcript = text
            case .done(let text):
                transcript = text
                phase = .idle
                socket.cancel(with: .normalClosure, reason: nil)
                return
            case .error(let message):
                stopMicrophone()
                phase = .failed(message)
                return
            default: break
            }
        }
        if phase != .idle { phase = .idle }
    }

    private func startMicrophone(sendingTo socket: URLSessionWebSocketTask) throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .duckOthers])
        try audio.setActive(true)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let converter = PCMConverter(from: format) else { throw PairingError(message: "This microphone format isn't supported.") }
        // 100 ms of audio per frame; each is converted and sent straight from the audio thread.
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: format) { buffer, _ in
            if let pcm = converter.convert(buffer) { socket.send(.data(pcm)) { _ in } }
        }
        engine.prepare()
        try engine.start()
    }

    private func stopMicrophone() {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
    }
}
#endif
