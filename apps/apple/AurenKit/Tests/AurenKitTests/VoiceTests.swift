import AVFoundation
import Foundation
import Testing
@testable import AurenKit

@Suite struct VoiceTests {
    @Test func convertsMicrophoneAudioTo24kMonoPCM16() throws {
        let input = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: input, frameCapacity: 4_800))
        buffer.frameLength = 4_800
        let samples = try #require(buffer.floatChannelData)
        for i in 0..<4_800 { samples[0][i] = 0.5 * sin(Float(i) * 2 * .pi * 440 / 48_000) }

        let converter = try #require(PCMConverter(from: input))
        var pcm = Data()
        for _ in 0..<5 { pcm.append(converter.convert(buffer) ?? Data()) }
        // Five 100 ms buffers at 48 kHz become about 0.5 s at 24 kHz: ~12,000 samples of 2 bytes.
        #expect(pcm.count > 22_000 && pcm.count <= 24_200)
        let peak = pcm.withUnsafeBytes { $0.bindMemory(to: Int16.self).map { abs(Int($0)) }.max() ?? 0 }
        #expect(peak > 10_000)
    }

    @Test func voicePayloadMatchesCoreAndDiffersFromHello() {
        #expect(String(decoding: DeviceIdentity.voicePayload(nonce: "n", deviceID: "phone-1"), as: UTF8.self) == "auren-voice\nn\nphone-1")
        #expect(DeviceIdentity.voicePayload(nonce: "n", deviceID: "p") != DeviceIdentity.helloPayload(nonce: "n", deviceID: "p"))
    }

    @Test func decodesTheVoiceChannel() throws {
        let decode = { (s: String) in try JSONDecoder().decode(VoiceMessage.self, from: Data(s.utf8)) }
        #expect(try decode(#"{"type":"challenge","nonce":"x"}"#) == .challenge(nonce: "x"))
        #expect(try decode(#"{"type":"transcript","text":"hey muse","final":false}"#) == .transcript(text: "hey muse", final: false))
        #expect(try decode(#"{"type":"done","text":"Move my 3 PM to 4."}"#) == .done(text: "Move my 3 PM to 4."))
        #expect(try decode(#"{"type":"error","message":"Pair this device first"}"#) == .error(message: "Pair this device first"))
        #expect(try decode(#"{"type":"later"}"#) == .unknown)
    }

    @Test func voiceURLSharesTheSurfaceHostAndToken() {
        #expect(voiceURL(core: URL(string: "http://127.0.0.1:8787")!, token: nil)?.absoluteString == "ws://127.0.0.1:8787/v1/voice")
        #expect(voiceURL(core: URL(string: "https://core.example:8443")!, token: "t")?.absoluteString == "wss://core.example:8443/v1/voice?token=t")
    }
}
