// WatchConnectivity under the relay: the watch and its iPhone exchange relay
// frames as messages, and the iPhone hands the watch its Core address and token
// through the application context, so nothing has to be typed on the wrist.
#if os(iOS) || os(watchOS)
import Foundation
import WatchConnectivity

public final class WatchLink: NSObject, RelayLink, WCSessionDelegate, @unchecked Sendable {
    public static let shared = WatchLink()

    private var handler: (@Sendable ([String: String]) -> Void)?
    private let lock = NSLock()
    /// Called on the watch when the iPhone sends a new Core address and token.
    public var onConfig: (@Sendable (_ coreURL: String, _ token: String) -> Void)?

    override private init() {
        super.init()
    }

    public func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// True when the counterpart app can take a message right now.
    public var isReachable: Bool {
        WCSession.isSupported() && WCSession.default.activationState == .activated && WCSession.default.isReachable
    }

    public func send(_ message: [String: String]) {
        guard isReachable else {
            lock.withLock { handler }?(["op": "closed", "reason": "The iPhone isn't reachable."])
            return
        }
        WCSession.default.sendMessage(message, replyHandler: nil) { [weak self] error in
            self?.lock.withLock { self?.handler }?(["op": "closed", "reason": error.localizedDescription])
        }
    }

    public func setHandler(_ handler: @escaping @Sendable ([String: String]) -> Void) {
        lock.withLock { self.handler = handler }
    }

    #if os(watchOS)
    /// R12, watch → iPhone: a signed voice clip, as a file (a message is too small for audio).
    /// The iPhone posts the bytes unchanged, so the watch's signature still covers them.
    public func transferClip(_ pcm: Data, metadata: [String: String]) throws {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else {
            throw RelayError(message: "Couldn't reach Core or your iPhone.")
        }
        let file = FileManager.default.temporaryDirectory.appending(path: "clip-\(UUID().uuidString).pcm")
        try pcm.write(to: file)
        WCSession.default.transferFile(file, metadata: metadata)
    }

    public func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        try? FileManager.default.removeItem(at: fileTransfer.file.fileURL)
    }
    #endif

    #if os(iOS)
    /// R12: called on the iPhone with each voice clip the watch hands over, to post to Core unchanged.
    public var onClip: (@Sendable (_ pcm: Data, _ metadata: [String: String]) -> Void)?

    public func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // WatchConnectivity deletes the file when this returns, so read it now, and never more than a clip can be.
        let size = (try? file.fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? .max
        guard size <= ClipBuffer.maxBytes, let pcm = try? Data(contentsOf: file.fileURL) else { return }
        onClip?(pcm, (file.metadata ?? [:]).compactMapValues { $0 as? String })
    }

    /// iPhone → watch: the address and token the watch should use.
    public func pushConfig(coreURL: String, token: String) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated, WCSession.default.isPaired, WCSession.default.isWatchAppInstalled else { return }
        try? WCSession.default.updateApplicationContext(["coreURL": coreURL, "token": token])
    }
    #endif

    // MARK: WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        let strings = message.compactMapValues { $0 as? String }
        lock.withLock { handler }?(strings)
    }

    public func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
        if let url = context["coreURL"] as? String { onConfig?(url, context["token"] as? String ?? "") }
    }

    #if os(iOS)
    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    #endif
}
#endif
