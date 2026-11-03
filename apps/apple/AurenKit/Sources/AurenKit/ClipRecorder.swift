// R12: hold to talk on the wrist. The microphone runs only while you hold; when you let go
// (or at 30 seconds), the audio is converted to PCM16 mono at 24 kHz, signed with the watch's
// key and sent with `ClipSender`: straight to Core, or through the iPhone if Core can't be reached.
#if os(watchOS)
import AVFoundation
import Foundation
import Observation

@MainActor
@Observable
public final class ClipRecorder {
    public enum Phase: Equatable, Sendable {
        case idle, recording, sending
        /// Core heard this and is running it ("" when it heard only the wake phrase).
        case sent(String)
        /// Core wasn't reachable from the watch, so the iPhone is posting the clip.
        case relayed
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    /// Played when a clip leaves the watch: a short haptic.
    public var onSend: (@MainActor () -> Void)?

    private let client: SurfaceClient
    private let sender: ClipSender
    private let engine = AVAudioEngine()
    private var buffer = ClipBuffer()
    private var target: (core: URL, token: String?)?
    // Letting go while the microphone is still starting must still stop it once it's on.
    private var starting = false
    private var stopRequested = false

    public init(client: SurfaceClient, sender: ClipSender) {
        self.client = client
        self.sender = sender
    }

    public func start(core: URL, token: String?) async {
        guard !starting, phase != .recording, phase != .sending else { return }
        starting = true
        stopRequested = false
        target = (core, token)
        let buffer = ClipBuffer()
        self.buffer = buffer
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                throw ClipFailure("Allow the microphone for Auren in Settings on your watch.")
            }
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .default)
            try audio.setActive(true)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard let converter = PCMConverter(from: format) else { throw ClipFailure("This microphone format isn't supported.") }
            // 100 ms at a time, converted on the audio thread. A full clip (30 s) stops by itself.
            input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: format) { [weak self] pcm, _ in
                guard let chunk = converter.convert(pcm), !buffer.append(chunk) else { return }
                Task { @MainActor in await self?.stop() }
            }
            engine.prepare()
            try engine.start()
            phase = .recording
        } catch {
            stopMicrophone()
            phase = .failed(error.localizedDescription)
        }
        starting = false
        if stopRequested { await stop() }
    }

    /// Let go: stop the microphone, sign the clip and send it. Core runs the command.
    public func stop() async {
        if starting {
            stopRequested = true
            return
        }
        guard phase == .recording, let target else { return }
        stopMicrophone()
        let pcm = buffer.bytes
        // Under a quarter of a second is a tap, not a command.
        guard pcm.count >= 12_000 else {
            phase = .idle
            return
        }
        phase = .sending
        do {
            let clip = try VoiceClip.make(pcm: pcm, surfaceID: client.manifest.id, identity: client.identity)
            onSend?()
            switch try await sender.send(clip, core: target.core, token: target.token) {
            case .direct(let text): phase = .sent(text)
            case .relayed: phase = .relayed
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func stopMicrophone() {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
#endif
