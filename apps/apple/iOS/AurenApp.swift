import AurenKit
import SwiftUI

@main
struct AurenApp: App {
    // The phone is one surface. From Day 5 this app also runs a second SurfaceClient
    // for the Ray-Ban Meta glasses, fed by the Meta Wearables Device Access Toolkit.
    @State private var phone: SurfaceClient
    // Carries the watch's connection to Core when the watch can't hold its own socket (TN3135).
    private let relay = RelayHost(link: WatchLink.shared, coreSocketURL: {
        let defaults = UserDefaults.standard
        guard let core = URL(string: defaults.string(forKey: "coreURL") ?? "http://127.0.0.1:8787") else { return nil }
        return SurfaceClient.socketURL(core: core, token: defaults.string(forKey: "token"))
    })

    init() {
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
