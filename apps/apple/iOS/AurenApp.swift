import AurenKit
import SwiftUI

@main
struct AurenApp: App {
    // The phone is one surface. From Day 5 this app also runs a second SurfaceClient
    // for the Ray-Ban Meta glasses, fed by the Meta Wearables Device Access Toolkit.
    @State private var phone: SurfaceClient

    init() {
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
