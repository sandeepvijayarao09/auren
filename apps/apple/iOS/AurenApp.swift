import AurenKit
import SwiftUI

@main
struct AurenApp: App {
    // The phone is one surface. From Day 5 this app also runs a second SurfaceClient
    // for the Ray-Ban Meta glasses, fed by the Meta Wearables Device Access Toolkit.
    @State private var phone = SurfaceClient(manifest: .phone(id: DeviceID.stable(prefix: "phone")))

    var body: some Scene {
        WindowGroup {
            HomeView(client: phone)
                .preferredColorScheme(.dark)
        }
    }
}
