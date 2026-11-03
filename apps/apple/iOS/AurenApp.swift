import AurenKit
import SwiftUI

@main
struct AurenApp: App {
    // The phone is one surface, and its camera answers Core's capture requests (plan B).
    // A second SurfaceClient for the Ray-Ban Meta glasses joins once WearablesToolkitCamera.isAvailable.
    @State private var phone: SurfaceClient
    // Carries the watch's connection to Core when the watch can't hold its own socket (TN3135).
    private let relay = RelayHost(link: WatchLink.shared, coreSocketURL: {
        let defaults = UserDefaults.standard
        guard let core = URL(string: defaults.string(forKey: "coreURL") ?? "http://127.0.0.1:8787") else { return nil }
        return SurfaceClient.socketURL(core: core, token: defaults.string(forKey: "token"))
    })

    // R12: the watch's voice clips, when it can't reach Core itself. Posted byte for byte, with the watch's signature.
    private static let clips = ClipRelayHost(core: {
        let defaults = UserDefaults.standard
        guard let core = URL(string: defaults.string(forKey: "coreURL") ?? "http://127.0.0.1:8787") else { return nil }
        return (core, defaults.string(forKey: "token"))
    })

    init() {
        WatchLink.shared.onClip = { pcm, metadata in Task { try? await Self.clips.forward(pcm: pcm, metadata: metadata) } }
        WatchLink.shared.activate()
        relay.start()
        let id = DeviceID.stable(prefix: "phone")
        // A Secure Enclave key on a real iPhone; a software key in the Simulator.
        let identity = try? DeviceIdentity.loadOrCreate(deviceID: id)
        _phone = State(initialValue: SurfaceClient(manifest: .phone(id: id), identity: identity))
    }

    var body: some Scene {
        WindowGroup {
            HomeView(client: phone)
                .preferredColorScheme(.dark)
        }
    }
}
