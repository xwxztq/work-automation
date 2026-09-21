import AppKit

final class ProbeDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let field = NSTextField(string: "")
    let result = NSTextField(labelWithString: "Waiting for input")
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "Quit NativeCapabilityProbe", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu
        menu.addItem(applicationItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 520, height: 240), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "WorkAutomation Native Capability Probe"
        field.placeholderString = "Type an English and Chinese test value"
        field.setAccessibilityIdentifier("probe-input")
        field.setAccessibilityLabel("Probe input")
        field.frame = NSRect(x: 25, y: 145, width: 470, height: 30)
        let button = NSButton(title: "Record test value", target: self, action: #selector(record))
        button.frame = NSRect(x: 25, y: 90, width: 180, height: 34)
        button.setAccessibilityIdentifier("probe-record")
        result.frame = NSRect(x: 25, y: 35, width: 470, height: 35)
        result.setAccessibilityIdentifier("probe-result")
        window.contentView?.addSubview(field)
        window.contentView?.addSubview(button)
        window.contentView?.addSubview(result)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func record() {
        result.stringValue = "Recorded: " + field.stringValue
        if let output = ProcessInfo.processInfo.environment["WAUTO_PROBE_OUTPUT"] {
            let data = try? JSONSerialization.data(withJSONObject: ["value": field.stringValue, "recordedAt": Date().timeIntervalSince1970])
            try? data?.write(to: URL(fileURLWithPath: output), options: .atomic)
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = ProbeDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
