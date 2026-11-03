// Camera frames, only when Core sends capture_request for a "this" command. A
// frame source (the glasses through the Meta Wearables toolkit, or the phone
// camera as plan B) takes one photo, the people in it are blurred on this
// device, and the result is uploaded to POST /v1/frames/:request_id, signed
// by this device's Secure Enclave key over the exact bytes.
import CryptoKit
import Foundation
#if os(iOS)
import AVFoundation
#endif

public extension DeviceIdentity {
    /// Must match framePayload in core/src/security/devices.ts: the request and a hash of the bytes sent.
    static func framePayload(requestID: String, jpeg: Data) -> Data {
        let hash = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
        return Data("auren-frame\n\(requestID)\n\(hash)".utf8)
    }

    func signFrame(requestID: String, jpeg: Data) throws -> String {
        try sign(Self.framePayload(requestID: requestID, jpeg: jpeg)).base64EncodedString()
    }
}

public struct CaptureFailure: Error, LocalizedError, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public enum FrameUpload {
    /// Core refuses anything larger.
    public static let maxBytes = 2 * 1024 * 1024

    /// The POST for one frame. With an identity it carries the device's signature; without one, Core takes it only from the Mac itself.
    public static func request(core: URL, token: String?, requestID: String, surfaceID: String, jpeg: Data, identity: DeviceIdentity?) throws -> URLRequest {
        guard jpeg.count <= maxBytes else { throw CaptureFailure("The photo is over 2 MB, so Core would refuse it.") }
        var request = URLRequest(url: core.appending(path: "v1/frames/\(requestID)"))
        request.httpMethod = "POST"
        request.httpBody = jpeg
        request.setValue("image/jpeg", forHTTPHeaderField: "content-type")
        request.setValue(surfaceID, forHTTPHeaderField: "x-auren-surface")
        if let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let identity {
            request.setValue(identity.deviceID, forHTTPHeaderField: "x-auren-device")
            request.setValue(try identity.signFrame(requestID: requestID, jpeg: jpeg), forHTTPHeaderField: "x-auren-signature")
        }
        return request
    }

    public static func send(_ request: URLRequest) async throws {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 202 else {
            let reason = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw CaptureFailure(reason ?? "Core didn't take the photo.")
        }
    }
}

/// A camera Auren can take one photo from. The bytes are the camera's own; `BystanderBlur.prepare` makes them safe to send.
public protocol FrameSource: Sendable {
    var kind: SurfaceKind { get }
    func capture() async throws -> Data
}

/// Ray-Ban Meta glasses through the Meta Wearables Device Access Toolkit. The toolkit isn't
/// in this build yet, so this stand-in says so, and the phone camera is plan B.
public struct WearablesToolkitCamera: FrameSource {
    /// True once the toolkit is linked and a pair of glasses is connected. Until then, don't
    /// run a glasses surface: Core would ask it first and it couldn't answer.
    public static let isAvailable = false
    public let kind = SurfaceKind.glasses

    public init() {}

    public func capture() async throws -> Data {
        throw CaptureFailure("The Meta Wearables toolkit isn't in this build, so the glasses can't take a photo yet.")
    }
}

#if os(iOS)
/// Plan B: the iPhone's back camera. It turns on for one photo and off again.
public final class PhoneCamera: NSObject, FrameSource, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    public let kind = SurfaceKind.phone
    // Everything below is used only on `queue`.
    private let queue = DispatchQueue(label: "dev.auren.camera")
    private let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var configured = false
    private var pending: CheckedContinuation<Data, any Error>?

    override public init() { super.init() }

    public func capture() async throws -> Data {
        guard await AVCaptureDevice.requestAccess(for: .video) else { throw CaptureFailure("Allow the camera for Auren in Settings.") }
        return try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                guard pending == nil else { return continuation.resume(throwing: CaptureFailure("The camera is already taking a photo.")) }
                do {
                    try configure()
                } catch {
                    return continuation.resume(throwing: error)
                }
                pending = continuation
                let starting = !session.isRunning
                if starting { session.startRunning() }
                // Exposure needs a moment after the camera starts.
                queue.asyncAfter(deadline: .now() + (starting ? 0.4 : 0)) { [self] in
                    output.capturePhoto(with: AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg]), delegate: self)
                }
            }
        }
    }

    private func configure() throws {
        guard !configured else { return }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw CaptureFailure("This device has no camera.")
        }
        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo
        guard session.canAddInput(input), session.canAddOutput(output) else { throw CaptureFailure("The camera couldn't be set up.") }
        session.addInput(input)
        session.addOutput(output)
        configured = true
    }

    public func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: (any Error)?) {
        let data = photo.fileDataRepresentation()
        queue.async { [self] in
            session.stopRunning()
            let continuation = pending
            pending = nil
            if let error {
                continuation?.resume(throwing: error)
            } else if let data {
                continuation?.resume(returning: data)
            } else {
                continuation?.resume(throwing: CaptureFailure("The camera returned no photo."))
            }
        }
    }
}
#endif

#if !os(watchOS)
/// Answers Core's capture requests for one surface: one photo, people blurred here, then the upload.
/// If the blur doesn't run, nothing is sent.
@MainActor
@Observable
public final class CaptureCoordinator {
    public enum Phase: Equatable, Sendable {
        case idle
        case looking(purpose: String)
        case sent
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    /// Where Core is, from the app's settings.
    public var core: URL?
    public var token: String?

    private let client: SurfaceClient
    private let camera: any FrameSource
    private let segmenter: any PersonSegmenter
    private let upload: @Sendable (URLRequest) async throws -> Void

    public init(client: SurfaceClient, camera: any FrameSource, segmenter: any PersonSegmenter = VisionPersonSegmenter(),
                upload: @escaping @Sendable (URLRequest) async throws -> Void = { try await FrameUpload.send($0) }) {
        self.client = client
        self.camera = camera
        self.segmenter = segmenter
        self.upload = upload
    }

    /// Starts answering `capture_request` on the client.
    public func attach() {
        client.onCapture = { [weak self] request in
            Task { [weak self] in await self?.handle(request) }
        }
    }

    public func handle(_ request: CaptureRequest) async {
        guard let core else {
            phase = .failed("Set the Core address first.")
            return
        }
        phase = .looking(purpose: request.purpose)
        do {
            let photo = try await camera.capture()
            let segmenter = segmenter
            let frame = try await Task.detached(priority: .userInitiated) { try BystanderBlur.prepare(photo, segmenter: segmenter) }.value
            try await upload(try FrameUpload.request(core: core, token: token, requestID: request.id, surfaceID: client.manifest.id,
                                                     jpeg: frame.jpeg, identity: client.identity))
            phase = .sent
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}
#endif
