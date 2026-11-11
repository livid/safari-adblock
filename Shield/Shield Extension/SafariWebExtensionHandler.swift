//
//  SafariWebExtensionHandler.swift
//  Shield Extension
//
//  Receives the extension's reports (background.js, reportToApp) and stores them where the
//  Shield app can read them for its window.
//

import SafariServices

/// The app group shared with the Shield app. Same names as in StatusView.swift (Mac) and
/// ShieldApp.swift (iOS), and in the targets' entitlements.
#if os(iOS)
let sharedSuiteName = "group.io.github.livid.Shield"
#else
let sharedSuiteName = "66KP7KX9MX.io.github.livid.Shield"
#endif

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        // Each Safari profile runs its own copy of the extension, with its own totals and
        // website access, so reports are kept per profile.
        let profile = (request?.userInfo?[SFExtensionProfileKey] as? UUID)?.uuidString ?? "default"

        var stored = false
        if message?["type"] as? String == "report", let shared = UserDefaults(suiteName: sharedSuiteName) {
            let stats = message?["stats"] as? [String: Any]
            var reports = shared.dictionary(forKey: "reports") ?? [:]
            reports[profile] = [
                "blocked": (stats?["blocked"] as? NSNumber)?.intValue ?? 0,
                "bytes": (stats?["bytes"] as? NSNumber)?.intValue ?? 0,
                "allSites": message?["allSites"] as? Bool ?? false,
                "updated": Date(),
            ]
            shared.set(reports, forKey: "reports")
            stored = true
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": stored]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

}
