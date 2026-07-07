import SwiftUI

struct UsageView: View {
    let api: RelayAPI?
    @State private var report: UsageReport?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        Group {
            if api == nil {
                Text("Set the relay URL and token in Settings.")
                    .foregroundStyle(.secondary)
            } else if let error {
                VStack(spacing: 8) {
                    Text(error).foregroundStyle(.red)
                    Button("Retry") { Task { await refresh() } }
                }
            } else if let r = report {
                content(r)
            } else {
                ProgressView()
            }
        }
        .frame(minWidth: 380, minHeight: 300)
        .task { await refresh() }
    }

    private func content(_ r: UsageReport) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Week of \(r.rangeStart) → \(r.rangeEnd) (UTC)")
                    .font(.headline)

                Text("Deepgram — variable cost").font(.title3.bold())
                if let dg = r.deepgram {
                    row("Audio transcribed",
                        String(format: "%.2f h (%.1f min)", dg.hours, dg.hours * 60))
                    row("Requests", "\(dg.requests)")
                    if let cost = r.estimatedDeepgramCost {
                        row("Est. cost", String(format: "~$%.2f (@ $%g/min)", cost, r.deepgramRatePerMin))
                    }
                } else {
                    Text("Unavailable — \(r.deepgramError ?? "unknown")")
                        .foregroundStyle(.secondary)
                }

                Divider()

                Text("Fly.io — fixed cost").font(.title3.bold())
                row("App", r.fly.appName)
                if let machines = r.fly.machines {
                    if machines.isEmpty {
                        row("Machines", "none found")
                    } else {
                        ForEach(machines) { m in
                            row("Machine", "\(m.id) [\(m.state) · \(m.region)]")
                        }
                    }
                } else {
                    Text("Machines unavailable — \(r.fly.machinesError ?? "unknown")")
                        .foregroundStyle(.secondary)
                }
                row("Est. cost", String(format: "~$%.2f/month (always-on machine)", r.fly.monthlyCostUsd))

                Text("Estimates only — confirm at console.deepgram.com and fly.io/dashboard.")
                    .font(.caption).foregroundStyle(.secondary)

                Button("Refresh") { Task { await refresh() } }
                    .disabled(loading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(.secondary).frame(width: 140, alignment: .leading)
            Text(value).textSelection(.enabled)
        }
        .font(.body)
    }

    private func refresh() async {
        guard let api else { return }
        loading = true
        defer { loading = false }
        do {
            report = try await api.usage()
            error = nil
        } catch {
            self.error = "\(error)"
        }
    }
}
