import AurenKit
import SwiftUI

struct SettingsView: View {
    @Binding var coreURL: String
    @Binding var token: String
    let client: SurfaceClient
    @AppStorage("paired") private var paired = false
    @State private var code = ""
    @State private var pairing = false
    @State private var message: String?
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
                    Text("In the Simulator, http://127.0.0.1:8787 reaches Core on this Mac. On a real iPhone, use your Mac's network address.")
                }
                Section {
                    if paired {
                        Label(client.identity?.isHardwareBacked == true ? "Paired · key in the Secure Enclave" : "Paired · software key (Simulator)",
                              systemImage: "checkmark.seal.fill")
                            .foregroundStyle(Color.aurenDone)
                    }
                    TextField("6-digit code", text: $code)
                        .keyboardType(.numberPad)
                        .font(.system(.title3, design: .monospaced))
                    Button(pairing ? "Pairing…" : paired ? "Pair again" : "Pair") { Task { await pair() } }
                        .disabled(code.filter(\.isNumber).count != 6 || pairing || client.identity == nil)
                    if let message {
                        Text(message).font(.footnote).foregroundStyle(Color.aurenStopped)
                    }
                } header: {
                    Text("Pair with your Mac")
                } footer: {
                    Text("On the Mac, open the console and choose Pair a device. Core keeps this iPhone's public key; the private key never leaves its Secure Enclave, and every approval you tap is signed with it.")
                }
            }
            .navigationTitle("Settings")
            .animation(.default, value: paired)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func pair() async {
        guard let identity = client.identity, let url = URL(string: coreURL) else { return }
        pairing = true
        defer { pairing = false }
        do {
            try await identity.pair(core: url, code: code.filter(\.isNumber), manifest: client.manifest)
            paired = true
            code = ""
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }
}
