import CoreImage
import CryptoKit
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import AurenKit

// MARK: synthetic images

/// One-pixel black and white stripes: the sharpest detail there is, so any blur shows.
private func stripes(width: Int, height: Int) -> CGImage {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    for x in stride(from: 0, to: width, by: 2) {
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: x, y: 0, width: 1, height: height))
        ctx.setFillColor(gray: 0, alpha: 1)
        ctx.fill(CGRect(x: x + 1, y: 0, width: 1, height: height))
    }
    return ctx.makeImage()!
}

/// Red channel of every pixel, row by row.
private func reds(_ image: CGImage) -> [UInt8] {
    let w = image.width, h = image.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return stride(from: 0, to: px.count, by: 4).map { px[$0] }
}

/// How much neighbouring pixels in columns [from, to) differ, on average. Stripes score ~255; a blur scores near 0.
private func sharpness(_ image: CGImage, columns: Range<Int>) -> Double {
    let r = reds(image), w = image.width
    var total = 0.0, n = 0.0
    for y in 0..<image.height {
        for x in columns.dropLast() {
            total += abs(Double(r[y * w + x]) - Double(r[y * w + x + 1]))
            n += 1
        }
    }
    return total / n
}

/// White over the left half, black over the right: "a person on the left".
private func leftHalfMask(width: Int, height: Int) -> CIImage {
    let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: width / 2, height: height))
    return white.composited(over: CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: width, height: height)))
}

private func jpeg(_ image: CGImage, properties: [CFString: Any] = [:]) -> Data {
    let data = NSMutableData()
    let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, properties as CFDictionary)
    CGImageDestinationFinalize(dest)
    return data as Data
}

private func image(_ data: Data) throws -> CGImage {
    try #require(CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
}

private struct FakeSegmenter: PersonSegmenter {
    var mask: (@Sendable (CGImage) -> CIImage)?
    func personMask(for image: CGImage) throws -> CIImage {
        guard let mask else { throw CaptureFailure("segmentation unavailable") }
        return mask(image)
    }
}

private struct FakeCamera: FrameSource {
    let kind = SurfaceKind.phone
    let photo: Data
    func capture() async throws -> Data { photo }
}

private final class Uploads: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [URLRequest] = []
    var all: [URLRequest] { lock.withLock { items } }
    func add(_ r: URLRequest) { lock.withLock { items.append(r) } }
}

// MARK: protocol and upload

@Suite struct CaptureProtocolTests {
    @Test func decodesCaptureRequest() throws {
        let message = try JSONDecoder().decode(ServerMessage.self, from: Data(#"{"type":"capture_request","request_id":"9f2c","purpose":"the event on this poster"}"#.utf8))
        #expect(message == .captureRequest(CaptureRequest(id: "9f2c", purpose: "the event on this poster")))
    }

    @MainActor @Test func theClientHandsCaptureRequestsToTheApp() {
        let client = SurfaceClient(manifest: .glasses(id: "glasses-1"))
        var asked: [CaptureRequest] = []
        client.onCapture = { asked.append($0) }
        client.apply(.captureRequest(CaptureRequest(id: "r1", purpose: "look")))
        #expect(asked == [CaptureRequest(id: "r1", purpose: "look")])
    }

    @Test func framePayloadMatchesCoreByteForByte() {
        // The same string core/src/vision/frames.test.ts pins: sha256("abc").
        #expect(String(decoding: DeviceIdentity.framePayload(requestID: "req-1", jpeg: Data("abc".utf8)), as: UTF8.self)
            == "auren-frame\nreq-1\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test func uploadIsSignedOverTheExactBytes() throws {
        let identity = try DeviceIdentity.loadOrCreate(deviceID: "phone-1", store: MemoryKeyStore(), useEnclave: false)
        let body = Data([0xFF, 0xD8, 0xFF, 0x01, 0x02])
        let request = try FrameUpload.request(core: URL(string: "http://192.168.1.20:8787")!, token: "t0k", requestID: "req-7",
                                              surfaceID: "phone-1", jpeg: body, identity: identity)
        #expect(request.url?.absoluteString == "http://192.168.1.20:8787/v1/frames/req-7")
        #expect(request.httpMethod == "POST")
        #expect(request.httpBody == body)
        #expect(request.value(forHTTPHeaderField: "content-type") == "image/jpeg")
        #expect(request.value(forHTTPHeaderField: "authorization") == "Bearer t0k")
        #expect(request.value(forHTTPHeaderField: "x-auren-surface") == "phone-1")
        #expect(request.value(forHTTPHeaderField: "x-auren-device") == "phone-1")

        let key = try P256.Signing.PublicKey(derRepresentation: identity.publicKeyDER)
        let signature = try P256.Signing.ECDSASignature(derRepresentation: try #require(Data(base64Encoded: request.value(forHTTPHeaderField: "x-auren-signature") ?? "")))
        #expect(key.isValidSignature(signature, for: DeviceIdentity.framePayload(requestID: "req-7", jpeg: body)))
        #expect(!key.isValidSignature(signature, for: DeviceIdentity.framePayload(requestID: "req-7", jpeg: body + Data([0]))))
    }

    @Test func uploadRefusesWhatCoreWould() {
        #expect(throws: CaptureFailure.self) {
            try FrameUpload.request(core: URL(string: "http://127.0.0.1:8787")!, token: nil, requestID: "r", surfaceID: "phone-1",
                                    jpeg: Data(count: FrameUpload.maxBytes + 1), identity: nil)
        }
    }

    @Test func theGlassesStubSaysWhyItCantLook() async {
        #expect(!WearablesToolkitCamera.isAvailable)
        #expect(WearablesToolkitCamera().kind == .glasses)
        await #expect(throws: CaptureFailure.self) { try await WearablesToolkitCamera().capture() }
    }
}

// MARK: bystander blur

@Suite struct BystanderBlurTests {
    @Test func blursWhereThereIsAPersonAndNowhereElse() throws {
        let input = stripes(width: 200, height: 100)
        #expect(sharpness(input, columns: 0..<200) > 250)
        let out = try #require(BystanderBlur.blur(input, where: leftHalfMask(width: 200, height: 100)))
        #expect(out.width == 200 && out.height == 100)
        // The "person" is gone; the rest is untouched, well clear of the grown edge.
        #expect(sharpness(out, columns: 0..<90) < 20)
        #expect(sharpness(out, columns: 130..<200) > 250)
    }

    @Test func aSmallMaskIsScaledToThePhoto() throws {
        // Vision's mask is smaller than the photo; the left half must still be covered.
        let small = leftHalfMask(width: 20, height: 10)
        let out = try #require(BystanderBlur.blur(stripes(width: 200, height: 100), where: small))
        #expect(sharpness(out, columns: 0..<90) < 20)
        #expect(sharpness(out, columns: 130..<200) > 250)
    }

    @Test func preparedFramesAreUprightResizedAndCarryNoLocation() throws {
        let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 42.34, kCGImagePropertyGPSLatitudeRef: "N",
                                    kCGImagePropertyGPSLongitude: 71.09, kCGImagePropertyGPSLongitudeRef: "W"]
        let photo = jpeg(stripes(width: 2400, height: 1200), properties: [kCGImagePropertyGPSDictionary: gps])
        let source = try #require(CGImageSourceCreateWithData(photo as CFData, nil))
        #expect((CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])?[kCGImagePropertyGPSDictionary] != nil)

        let frame = try BystanderBlur.prepare(photo, segmenter: FakeSegmenter { _ in CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8)) })
        #expect(frame.width == 1280 && frame.height == 640)
        #expect(frame.jpeg.count < FrameUpload.maxBytes)
        let out = try #require(CGImageSourceCreateWithData(frame.jpeg as CFData, nil))
        let props = CGImageSourceCopyPropertiesAtIndex(out, 0, nil) as? [CFString: Any] ?? [:]
        #expect(props[kCGImagePropertyGPSDictionary] == nil)
    }

    @Test func theRealSegmenterRunsOnThisDevice() throws {
        // No person in a stripe pattern: Vision returns a mask, and it's (nearly) empty.
        let mask = try VisionPersonSegmenter().personMask(for: stripes(width: 256, height: 256))
        #expect(mask.extent.width > 0)
        let avg = CIFilter(name: "CIAreaAverage", parameters: [kCIInputImageKey: mask, kCIInputExtentKey: CIVector(cgRect: mask.extent)])!.outputImage!
        var pixel = [UInt8](repeating: 0, count: 4)
        CIContext().render(avg, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
        #expect(pixel[0] < 40)
    }
}

// MARK: the whole capture, as the phone runs it

@MainActor
@Suite struct CaptureCoordinatorTests {
    private func coordinator(segmenter: FakeSegmenter, uploads: Uploads) throws -> CaptureCoordinator {
        let identity = try DeviceIdentity.loadOrCreate(deviceID: "phone-1", store: MemoryKeyStore(), useEnclave: false)
        let client = SurfaceClient(manifest: .phone(id: "phone-1"), identity: identity)
        let coordinator = CaptureCoordinator(client: client, camera: FakeCamera(photo: jpeg(stripes(width: 400, height: 200))),
                                             segmenter: segmenter, upload: { uploads.add($0) })
        coordinator.core = URL(string: "http://127.0.0.1:8787")
        return coordinator
    }

    @Test func theUploadIsTheBlurredPhotoSigned() async throws {
        let uploads = Uploads()
        // Someone fills the whole frame.
        let c = try coordinator(segmenter: FakeSegmenter { _ in CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4)) }, uploads: uploads)
        await c.handle(CaptureRequest(id: "req-1", purpose: "the event on this poster"))
        #expect(c.phase == .sent)
        let sent = try #require(uploads.all.first)
        let body = try #require(sent.httpBody)
        #expect(sent.url?.path == "/v1/frames/req-1")
        #expect(sharpness(try image(body), columns: 0..<400) < 20, "what left the phone was blurred")
        #expect(sent.value(forHTTPHeaderField: "x-auren-signature") != nil)
    }

    @Test func nothingIsSentIfTheBlurCantRun() async throws {
        let uploads = Uploads()
        let c = try coordinator(segmenter: FakeSegmenter(mask: nil), uploads: uploads)
        await c.handle(CaptureRequest(id: "req-2", purpose: "look"))
        #expect(uploads.all.isEmpty)
        #expect(c.phase == .failed("segmentation unavailable"))
    }
}
