//
//  ViewController.swift
//  Shield
//

import Cocoa
import SafariServices
import SwiftUI

let extensionBundleIdentifier = "io.github.livid.Shield.Extension"

/// Hosts the window's content, which is the SwiftUI `StatusView`.
class ViewController: NSViewController {

    private let status = ShieldStatus()

    override func viewDidLoad() {
        super.viewDidLoad()

        let content = NSHostingView(rootView: StatusView(status: status, openSafariSettings: {
            Task { try? await SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) }
        }))
        content.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content)
        // The window isn't resizable: it takes the size of its content.
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: view.topAnchor),
            content.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.center()
    }

}
