//
//  StatusView.swift
//  Shield
//
//  The app window: whether the extension is on, the lifetime totals, and a reminder to allow
//  Shield on every website.
//

import SafariServices
import SwiftUI

/// The app group the Safari extension writes its reports to. Same name as in
/// SafariWebExtensionHandler.swift and in both targets' entitlements.
let sharedSuiteName = "66KP7KX9MX.io.github.livid.Shield"

/// What the window shows. The totals and the website access come from the extension, which
/// reports them through SafariWebExtensionHandler (one report per Safari profile).
@Observable
final class ShieldStatus {

    /// nil until Safari has answered.
    private(set) var extensionEnabled: Bool?
    private(set) var blocked = 0
    private(set) var bytes = 0
    /// nil until the extension has reported, which it does each time Safari starts it.
    private(set) var allowedOnEveryWebsite: Bool?

    private let shared = UserDefaults(suiteName: sharedSuiteName)

    func refresh() async {
        let state = try? await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: extensionBundleIdentifier)
        extensionEnabled = state?.isEnabled

        let reports = (shared?.dictionary(forKey: "reports") ?? [:]).values.compactMap { $0 as? [String: Any] }
        blocked = reports.reduce(0) { $0 + ($1["blocked"] as? Int ?? 0) }
        bytes = reports.reduce(0) { $0 + ($1["bytes"] as? Int ?? 0) }
        // Website access is set per profile; go by the profile that was used last.
        let updated = { (report: [String: Any]) in report["updated"] as? Date ?? .distantPast }
        allowedOnEveryWebsite = reports.max { updated($0) < updated($1) }?["allSites"] as? Bool
    }

}

struct StatusView: View {

    let status: ShieldStatus
    let openSafariSettings: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            VStack(spacing: 6) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 88, height: 88)
                    .accessibilityHidden(true)
                Text(verbatim: "Shield")
                    .font(.title.bold())
                switch status.extensionEnabled {
                case true?: Text("Shield is on in Safari.").foregroundStyle(.secondary)
                case false?: Text("Shield is turned off in Safari.").foregroundStyle(.secondary)
                case nil: Text(verbatim: " ")
                }
            }

            VStack(spacing: 8) {
                HStack(spacing: 12) {
                    total(Text(verbatim: status.blocked.formatted()), label: Text("requests blocked"))
                    total(Text(verbatim: "≈ " + savedText), label: Text("data saved"))
                }
                Text("Totals since you installed Shield. Data saved is an estimate.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if status.extensionEnabled == false {
                reminder(
                    title: Text("Turn on Shield in Safari"),
                    steps: Text("In Safari Settings → Extensions, select the checkbox next to Shield. Then click Edit Websites… and set “When visiting other websites” to Allow."))
            } else if status.extensionEnabled == true, status.allowedOnEveryWebsite != true {
                reminder(
                    title: Text("Allow Shield on every website"),
                    steps: Text("In Safari Settings → Extensions → Shield, click Edit Websites…, then set “When visiting other websites” to Allow. Until then Safari asks site by site, and Shield can’t hide ads on sites it hasn’t been allowed on."))
            } else if status.extensionEnabled == true {
                Label("Shield is allowed on every website.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }

            Button("Open Safari Settings…", action: openSafariSettings)
                .controlSize(.large)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 28)
        .padding(.top, 20)
        .padding(.bottom, 26)
        .frame(width: 440)
        .fixedSize(horizontal: false, vertical: true)
        .task {
            // Safari and the extension change things behind the app's back, so keep looking.
            while !Task.isCancelled {
                await status.refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private var savedText: String {
        Int64(status.bytes).formatted(.byteCount(style: .file, allowedUnits: [.kb, .mb, .gb], spellsOutZero: false))
    }

    private func total(_ value: Text, label: Text) -> some View {
        VStack(spacing: 2) {
            value
                .font(.system(size: 28, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            label
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }

    private func reminder(title: Text, steps: Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 4) {
                title.font(.headline)
                steps.font(.callout).foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.orange.opacity(0.35)))
    }

}
