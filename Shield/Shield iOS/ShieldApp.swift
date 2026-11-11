//
//  ShieldApp.swift
//  Shield iOS
//
//  The iPhone and iPad app. Like the Mac window (StatusView.swift), it shows the lifetime
//  totals and reminds people to allow Shield on every website. The totals and the website
//  access come from the extension's reports (SafariWebExtensionHandler.swift). From iOS 26.2
//  the system also says whether the extension is on, and tapping the reminder opens the
//  extension's page in Settings; before that the reminder is only text.
//

import SafariServices
import SwiftUI

let extensionBundleIdentifier = "io.github.livid.Shield.Extension"

/// The app group the Safari extension writes its reports to. Same name as in
/// SafariWebExtensionHandler.swift and in both iOS targets' entitlements.
let sharedSuiteName = "group.io.github.livid.Shield"

@main
struct ShieldApp: App {
    var body: some Scene {
        WindowGroup { StatusView() }
    }
}

struct StatusView: View {

    @State private var blocked = 0
    @State private var bytes = 0
    /// nil until the extension has reported, which it does each time Safari starts it.
    @State private var allowedOnEveryWebsite: Bool?
    /// nil before iOS 26.2, which can't say.
    @State private var extensionEnabled: Bool?

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 8) {
                    Image("Icon")
                        .resizable()
                        .frame(width: 104, height: 104)
                        .accessibilityHidden(true)
                    Text(verbatim: "Shield")
                        .font(.largeTitle.bold())
                }

                VStack(spacing: 10) {
                    HStack(spacing: 12) {
                        total(Text(verbatim: blocked.formatted()), label: Text("requests blocked"))
                        total(Text(verbatim: "≈ " + savedText), label: Text("data saved"))
                    }
                    Text("Totals since you installed Shield. Data saved is an estimate.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                // Without the system's word on it, no report yet means the extension is off.
                switch (extensionEnabled ?? (allowedOnEveryWebsite != nil), allowedOnEveryWebsite) {
                case (true, true?):
                    Label("Shield is allowed on every website.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    if canOpenSettings {
                        Button("Open Settings", action: openSettings)
                    }
                case (true, _):
                    reminder(
                        title: Text("Allow Shield on every website"),
                        steps: Text("In Settings → Apps → Safari → Extensions → Shield – Ad & Threat Blocker, set “All Websites” to Allow. Until then Safari asks site by site, and Shield can’t hide ads on sites it hasn’t been allowed on."))
                case (false, _):
                    reminder(
                        title: Text("Turn on Shield in Safari"),
                        steps: Text("In Settings → Apps → Safari → Extensions → Shield – Ad & Threat Blocker, turn on “Allow Extension”. Then set “All Websites” to Allow."))
                }
            }
            .multilineTextAlignment(.center)
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .task {
            // The extension reports while this app is open too, so keep looking.
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private var canOpenSettings: Bool {
        if #available(iOS 26.2, *) { true } else { false }
    }

    /// Opens Shield's page under Settings → Apps → Safari → Extensions.
    private func openSettings() {
        guard #available(iOS 26.2, *) else { return }
        SFSafariSettings.openExtensionsSettings(forIdentifiers: [extensionBundleIdentifier]) { error in
            if let error { print("Shield: couldn't open Safari's extension settings: \(error)") }
        }
    }

    private func refresh() async {
        if #available(iOS 26.2, *) {
            extensionEnabled = (try? await SFSafariExtensionManager.stateOfExtension(withIdentifier: extensionBundleIdentifier))?.isEnabled
        }
        let shared = UserDefaults(suiteName: sharedSuiteName)
        let reports = (shared?.dictionary(forKey: "reports") ?? [:]).values.compactMap { $0 as? [String: Any] }
        blocked = reports.reduce(0) { $0 + ($1["blocked"] as? Int ?? 0) }
        bytes = reports.reduce(0) { $0 + ($1["bytes"] as? Int ?? 0) }
        // Website access is set per profile; go by the profile that was used last.
        let updated = { (report: [String: Any]) in report["updated"] as? Date ?? .distantPast }
        allowedOnEveryWebsite = reports.max { updated($0) < updated($1) }?["allSites"] as? Bool
    }

    private var savedText: String {
        Int64(bytes).formatted(.byteCount(style: .file, allowedUnits: [.kb, .mb, .gb], spellsOutZero: false))
    }

    private func total(_ value: Text, label: Text) -> some View {
        VStack(spacing: 2) {
            value
                .font(.system(size: 28, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            label
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .padding(.horizontal, 8)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }

    /// The steps to take in Settings. Where the system can open that page, tapping does.
    private func reminder(title: Text, steps: Text) -> some View {
        Button(action: openSettings) {
            HStack(spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 4) {
                        title.font(.headline).foregroundStyle(.primary)
                        steps.font(.callout).foregroundStyle(.secondary)
                        if canOpenSettings {
                            Text("Open Settings").font(.callout.weight(.semibold)).foregroundStyle(.tint).padding(.top, 4)
                        }
                    }
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if canOpenSettings {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(16)
            .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.orange.opacity(0.35)))
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .allowsHitTesting(canOpenSettings)
    }

}
