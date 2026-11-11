//
//  AppDelegate.swift
//  Shield
//

import Cocoa
import Sparkle

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    // Sparkle reads the appcast attached to the latest GitHub release (SUFeedURL in
    // Info.plist), at launch and daily while the app runs. Debug builds don't check, so a
    // development copy is never replaced by a release.
    #if DEBUG
    let updaterController: SPUStandardUpdaterController? = nil
    #else
    let updaterController: SPUStandardUpdaterController? = SPUStandardUpdaterController(
        startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    #endif

    /// True while Sparkle is checking, downloading or installing; the app stays open meanwhile.
    var updateInProgress: Bool { updaterController?.updater.sessionInProgress ?? false }

    func applicationDidFinishLaunching(_ notification: Notification) {
        addCheckForUpdatesMenuItem()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return !updateInProgress
    }

    // "Check for Updates…" in the app menu, right after "About Shield".
    private func addCheckForUpdatesMenuItem() {
        guard let updaterController, let appMenu = NSApp.mainMenu?.items.first?.submenu else { return }
        let item = NSMenuItem(
            title: "Check for Updates…",
            action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)),
            keyEquivalent: "")
        item.target = updaterController
        appMenu.insertItem(item, at: min(1, appMenu.numberOfItems))
    }

}
