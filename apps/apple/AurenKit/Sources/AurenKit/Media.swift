// R12: pictures on the timeline. Computer use logs a small JPEG of the browser after each
// step (`browser_frame`), and a receipt after glasses.look carries the crop of what the camera
// saw (`crop_id`, served by GET /v1/crops/:id). Both are checked before they're shown: only
// JPEG bytes, only under a size cap, and a crop id must look like one Core makes.
import Foundation

/// One computer-use step, as Core logs it: `{step, status, host, title, frame}`.
public struct BrowserFrame: Sendable, Equatable {
    /// Core's driver hub refuses larger frames; they're about 6 KB in practice.
    public static let maxBytes = 200_000
    static let prefix = "data:image/jpeg;base64,"

    public let step: Int
    /// `ok`, `paused` (waiting for your tap at the commit), `stopped` or `error`.
    public let status: String
    public let host: String
    public let title: String
    public let jpeg: Data

    /// Nil unless the event is a `browser_frame` whose frame is a `data:image/jpeg;base64` URL of real JPEG bytes, at most 200 KB.
    public init?(event: AurenEvent) {
        guard event.kind == .browserFrame, let url = event.string("frame"), let jpeg = Self.decode(dataURL: url) else { return nil }
        step = event.data["step"].flatMap { if case .number(let n) = $0 { Int(exactly: n.rounded()) } else { nil } } ?? 0
        status = event.string("status") ?? "ok"
        host = event.string("host") ?? ""
        title = event.string("title") ?? ""
        self.jpeg = jpeg
    }

    /// The JPEG inside a data URL, or nil for any other type, bad base64, too many bytes, or bytes that aren't a JPEG.
    public static func decode(dataURL: String) -> Data? {
        guard dataURL.hasPrefix(prefix) else { return nil }
        let base64 = dataURL.dropFirst(prefix.count)
        // Refuse before decoding: base64 is 4 characters for every 3 bytes.
        guard base64.utf8.count <= (maxBytes + 2) / 3 * 4, let data = Data(base64Encoded: String(base64)) else { return nil }
        return data.count <= maxBytes && isJPEG(data) ? data : nil
    }
}

func isJPEG(_ data: Data) -> Bool {
    data.count > 3 && data.starts(with: [0xFF, 0xD8, 0xFF])
}

public extension AurenEvent {
    /// The browser frame this event carries, if it's a valid one.
    var browserFrame: BrowserFrame? { BrowserFrame(event: self) }

    /// The crop a receipt carries (what the camera saw for "add this"), if its id is one Core makes.
    var cropID: String? { string("crop_id").flatMap { CropImage.isValid($0) ? $0 : nil } }
}

public extension Array where Element == AurenEvent {
    /// The newest computer-use frame. The timeline shows its picture; older steps stay as one line each.
    var liveBrowserFrameID: Int? { last { $0.kind == .browserFrame && $0.browserFrame != nil }?.id }
}

/// GET /v1/crops/:id, with the same bearer token as the rest of /v1 (the app already sends it for /v1/events).
public enum CropImage {
    /// Core's crops are at most 640 px; anything near this is not one of them.
    public static let maxBytes = 1_000_000

    /// `crop_` and 16 hex digits, as Core's CropStore names them. Nothing else becomes part of a URL.
    public static func isValid(_ id: String) -> Bool {
        id.count == 21 && id.hasPrefix("crop_") && id.dropFirst(5).allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    public static func request(core: URL, token: String?, cropID: String) -> URLRequest? {
        guard isValid(cropID) else { return nil }
        var request = URLRequest(url: core.appending(path: "v1/crops/\(cropID)"))
        if let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        return request
    }

    /// The crop's JPEG bytes. Throws for anything but a 200 with JPEG bytes under the cap.
    public static func fetch(_ request: URLRequest, using load: @Sendable (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }) async throws -> Data {
        let (data, response) = try await load(request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw CaptureFailure("Core doesn't have that picture.") }
        guard data.count <= maxBytes, isJPEG(data) else { throw CaptureFailure("That picture isn't a JPEG Auren would show.") }
        return data
    }
}
