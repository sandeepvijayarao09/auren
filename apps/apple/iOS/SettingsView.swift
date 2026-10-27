import SwiftUI

struct SettingsView: View {
    @Binding var coreURL: String
    @Binding var token: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.20:8787", text: $coreURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("AUREN_TOKEN", text: $token)
                } header: {
                    Text("Auren Core")
                } footer: {
                    Text("In the Simulator, http://127.0.0.1:8787 reaches Core on this Mac. On a real iPhone, use your Mac's network address and set AUREN_TOKEN in .env.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}
