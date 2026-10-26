// Spot Server for macOS: sets up and controls the Spot Solutions server on this Mac.
// A thin native shell around `spotctl` (bundled in Resources) plus the server console
// (http://127.0.0.1:7420), embedded so the Mac shows the same UI as Linux and Windows.
import AppKit
import SwiftUI
import WebKit

let brand = Color(red: 0.91, green: 0.64, blue: 0.24)
let consoleURL = URL(string: "http://127.0.0.1:7420/")!
let webAppURL = URL(string: "https://spot-solutions.web.app")!
let supportDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/SpotSolutions")

// MARK: - Model

@MainActor
final class Server: ObservableObject {
    @Published var status: [String: String] = [:]
    @Published var busy: String? = nil          // label of the running action
    @Published var log: String = ""
    @Published var lastError: String? = nil
    @Published var adminEmail: String = ""

    private var timer: Timer?
    private let ctl = Bundle.main.path(forResource: "spotctl", ofType: nil) ?? ""

    var installed: Bool { status["installed"] == "yes" }
    var localModel: Bool { status["localmodel"] != "off" }
    var services: [(String, String)] {
        let rest = [("WhatsApp worker", status["worker"] ?? "stopped"), ("Server console", status["console"] ?? "stopped")]
        return localModel ? [("Ollama (Gemma)", status["ollama"] ?? "stopped")] + rest : rest   // Gemini-only: no Ollama row
    }
    var running: Bool { status["console"] == "running" || status["worker"] == "running" }
    var allUp: Bool { services.allSatisfy { $0.1 == "running" || $0.1 == "external" } }
    var hasKey: Bool { status["key"] == "yes" }
    var awake: Bool { status["awake"] == "on" }
    var atLogin: Bool { status["login"] == "on" }

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
    }

    func refresh() {
        guard busy == nil || busy == "Setting up" else { return }
        Task.detached { [ctl] in
            let out = Self.run(ctl, ["status"]).output
            var s: [String: String] = [:]
            for line in out.split(separator: "\n") {
                let p = line.split(separator: "=", maxSplits: 1).map(String.init)
                if p.count == 2 { s[p[0]] = p[1] }
            }
            let snapshot = s
            await MainActor.run { self.status = snapshot }
        }
    }

    /// Run a spotctl command, streaming its output into `log`.
    func perform(_ label: String, _ args: [String], env: [String: String] = [:]) {
        guard busy == nil else { return }
        busy = label
        lastError = nil
        if args.first == "setup" { log = "" }
        let ctl = self.ctl
        Task.detached {
            let result = Self.run(ctl, args, env: env) { chunk in
                Task { @MainActor in self.log += chunk }
            }
            await MainActor.run {
                self.busy = nil
                if result.code != 0 { self.lastError = result.output.split(separator: "\n").last.map(String.init) ?? "\(label) failed" }
                self.refresh()
            }
        }
    }

    nonisolated static func run(_ ctl: String, _ args: [String], env: [String: String] = [:], onOutput: ((String) -> Void)? = nil) -> (code: Int32, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [ctl] + args
        var e = ProcessInfo.processInfo.environment
        e.merge(env) { $1 }
        p.environment = e
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        final class Buffer: @unchecked Sendable { var text = ""; let lock = NSLock() }
        let buf = Buffer()
        pipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            guard !d.isEmpty, let s = String(data: d, encoding: .utf8) else { return }
            buf.lock.lock(); buf.text += s; buf.lock.unlock()
            onOutput?(s)
        }
        do { try p.run() } catch { return (1, "Couldn't run spotctl: \(error.localizedDescription)") }
        p.waitUntilExit()
        pipe.fileHandleForReading.readabilityHandler = nil
        if let rest = try? pipe.fileHandleForReading.readToEnd(), let s = String(data: rest, encoding: .utf8), !s.isEmpty { buf.text += s; onOutput?(s) }
        return (p.terminationStatus, buf.text)
    }
}

// MARK: - Views

struct ContentView: View {
    @EnvironmentObject var server: Server

    var body: some View {
        Group {
            if server.status.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !server.installed || server.busy == "Setting up" {
                SetupView()
            } else {
                DashboardView()
            }
        }
        .frame(minWidth: 820, minHeight: 600)
        .tint(brand)
    }
}

struct Logo: View {
    var size: CGFloat = 44
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(brand.gradient)
            Image(systemName: "mic.fill").font(.system(size: size * 0.48, weight: .semibold)).foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}

struct SetupView: View {
    @EnvironmentObject var server: Server

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 28) {
                VStack(alignment: .leading, spacing: 18) {
                    Logo(size: 56)
                    Text("Turn this Mac into a\nSpot Solutions server").font(.system(size: 30, weight: .semibold, design: .rounded))
                    VStack(alignment: .leading, spacing: 10) {
                        Bullet("cpu", "Downloads Node.js and, if this Mac has about 8 GB of memory, a local Gemma model (about 3.5 GB). No Homebrew needed.")
                        Bullet("lock.shield", "Local model or Gemini? You choose in the console afterwards, and can switch any time.")
                        Bullet("bolt.horizontal", "Runs in the background and restarts itself if it crashes.")
                        Bullet("laptopcomputer", "Optionally keeps running with the lid closed.")
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Your email (optional: signing in from the console adds it)").font(.callout).foregroundStyle(.secondary)
                        TextField("you@gmail.com", text: $server.adminEmail).textFieldStyle(.roundedBorder).frame(maxWidth: 340)
                    }
                    Button {
                        server.perform("Setting up", ["setup"], env: [
                            "ADMIN_EMAILS": server.adminEmail.trimmingCharacters(in: .whitespaces).lowercased(),
                        ])
                    } label: {
                        Label(server.busy == nil ? "Set up this Mac" : "Setting up…", systemImage: "arrow.down.circle.fill").padding(.horizontal, 6)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(server.busy != nil)
                    if let e = server.lastError { Text(e).foregroundStyle(.red).font(.callout) }
                }
                .frame(maxWidth: 380, alignment: .leading)

                LogView(text: server.log.isEmpty ? "Setup progress shows up here." : server.log, live: server.busy != nil)
            }
            .padding(36)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct Bullet: View {
    let icon: String, text: String
    init(_ icon: String, _ text: String) { self.icon = icon; self.text = text }
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(brand).frame(width: 20)
            Text(text).foregroundStyle(.secondary)
        }
    }
}

struct LogView: View {
    let text: String
    var live = false
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .topLeading).textSelection(.enabled).padding(14)
                Color.clear.frame(height: 1).id("end")
            }
            .onChange(of: text) { _ in if live { proxy.scrollTo("end") } }
        }
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(nsColor: .textBackgroundColor).opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.quaternary))
    }
}

struct DashboardView: View {
    @EnvironmentObject var server: Server

    var body: some View {
        VStack(spacing: 0) {
            // Header: status, the one big action, and the two Mac-specific switches.
            HStack(spacing: 16) {
                Logo()
                VStack(alignment: .leading, spacing: 3) {
                    Text("Spot Server").font(.title2.weight(.semibold))
                    HStack(spacing: 6) {
                        Circle().fill(server.allUp ? .green : server.running ? .orange : .secondary).frame(width: 8, height: 8)
                        Text(server.allUp ? "Running" : server.running ? "Starting…" : "Stopped").foregroundStyle(.secondary)
                        if let v = server.status["version"], v != "none" { Text("· v\(v)").foregroundStyle(.tertiary) }
                    }
                    .font(.callout)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    Toggle("Keep awake, even with the lid closed", isOn: Binding(get: { server.awake }, set: { server.perform("Updating sleep", ["awake", $0 ? "on" : "off"]) }))
                    Toggle("Start when I log in", isOn: Binding(get: { server.atLogin }, set: { server.perform("Updating login", ["login", $0 ? "on" : "off"]) }))
                }
                .toggleStyle(.switch).controlSize(.small)
                if server.running {
                    Button(role: .destructive) { server.perform("Stopping", ["stop"]) } label: { Label("Stop server", systemImage: "stop.fill") }
                        .controlSize(.large)
                } else {
                    Button { server.perform("Starting", ["start"]) } label: { Label("Start server", systemImage: "play.fill") }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                }
            }
            .disabled(server.busy != nil)
            .padding(.horizontal, 22).padding(.vertical, 16)

            // Services strip
            HStack(spacing: 18) {
                ForEach(server.services, id: \.0) { name, state in
                    HStack(spacing: 6) {
                        Circle().fill(state == "running" || state == "external" ? .green : state == "starting" ? .orange : .red.opacity(0.8)).frame(width: 7, height: 7)
                        Text(name).font(.callout)
                        Text(state == "external" ? "your Ollama" : state).font(.caption).foregroundStyle(.tertiary)
                    }
                }
                Spacer()
                if let b = server.busy { ProgressView().controlSize(.small); Text("\(b)…").font(.callout).foregroundStyle(.secondary) }
                if let e = server.lastError { Text(e).font(.callout).foregroundStyle(.red).lineLimit(1) }
            }
            .padding(.horizontal, 22).padding(.bottom, 12)

            Divider()

            if server.status["console"] == "running" {
                ConsoleWebView(url: consoleURL)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "server.rack").font(.system(size: 40)).foregroundStyle(.tertiary)
                    Text(server.running ? "Starting the console…" : "The server is stopped").font(.title3)
                    Text("Start it to manage keys, see health and read logs.").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .toolbar {
            ToolbarItemGroup {
                Button { NSWorkspace.shared.open(webAppURL) } label: { Label("Open Spot Solutions", systemImage: "safari") }
                Button { NSWorkspace.shared.open(consoleURL) } label: { Label("Console in browser", systemImage: "rectangle.on.rectangle") }
                Button { NSWorkspace.shared.open(supportDir.appendingPathComponent("logs")) } label: { Label("Logs folder", systemImage: "doc.text.magnifyingglass") }
                Menu {
                    Button("Update Spot Solutions") { server.perform("Updating", ["update"]) }
                    Button("Restart worker") { server.perform("Restarting", ["restart", "worker"]) }
                    if server.localModel { Button("Restart Ollama") { server.perform("Restarting", ["restart", "ollama"]) } }
                    Divider()
                    Button("Uninstall (keep WhatsApp session and keys)…") {
                        if confirm("Uninstall Spot Server?", "Stops the server and removes the code. Your WhatsApp session and keys stay, so reinstalling picks up where you left off.") {
                            server.perform("Uninstalling", ["uninstall"])
                        }
                    }
                } label: { Label("More", systemImage: "ellipsis.circle") }
            }
        }
    }
}

func confirm(_ title: String, _ text: String) -> Bool {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.addButton(withTitle: "Uninstall")
    a.addButton(withTitle: "Cancel")
    a.alertStyle = .warning
    return a.runModal() == .alertFirstButtonReturn
}

/// The same console Linux and Windows serve, embedded. Reloads when the console comes back.
struct ConsoleWebView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let v = WKWebView()
        v.setValue(false, forKey: "drawsBackground")
        v.load(URLRequest(url: url))
        context.coordinator.view = v
        context.coordinator.schedule()
        return v
    }
    func updateNSView(_ v: WKWebView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator {
        weak var view: WKWebView?
        private var timer: Timer?
        private var boot: Double?
        private var active: NSObjectProtocol?
        /// Keeps the page current: retries until the console answers, and reloads when the console restarts
        /// (an update or a restart serves new code) or when the app comes to the front.
        func schedule() {
            timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] t in
                guard let self, let v = self.view else { return t.invalidate() }
                if v.url == nil || v.title?.isEmpty == true { v.load(URLRequest(url: consoleURL)); return }
                self.checkBoot()
            }
            active = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.view?.reload()
            }
        }
        private func checkBoot() {
            URLSession.shared.dataTask(with: consoleURL.appendingPathComponent("api/boot")) { [weak self] data, _, _ in
                guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let b = obj["boot"] as? Double else { return }
                DispatchQueue.main.async {
                    guard let self else { return }
                    if let old = self.boot, old != b { self.view?.load(URLRequest(url: consoleURL)) }
                    self.boot = b
                }
            }.resume()
        }
        deinit {
            timer?.invalidate()
            if let active { NotificationCenter.default.removeObserver(active) }
        }
    }
}

struct MenuContent: View {
    @EnvironmentObject var server: Server
    @Environment(\.openWindow) var openWindow
    var body: some View {
        Text(server.allUp ? "Spot Server is running" : server.running ? "Spot Server is starting" : "Spot Server is stopped")
        Divider()
        if server.installed {
            if server.running { Button("Stop server") { server.perform("Stopping", ["stop"]) } }
            else { Button("Start server") { server.perform("Starting", ["start"]) } }
        }
        Button("Open Spot Server…") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
        Button("Open Spot Solutions") { NSWorkspace.shared.open(webAppURL) }
        Divider()
        Button("Quit (server keeps running)") { NSApp.terminate(nil) }
    }
}

@main
struct SpotServerApp: App {
    @StateObject private var server = Server()
    var body: some Scene {
        Window("Spot Server", id: "main") {
            ContentView().environmentObject(server)
        }
        .defaultSize(width: 1040, height: 720)
        MenuBarExtra {
            MenuContent().environmentObject(server)
        } label: {
            Image(systemName: server.allUp ? "mic.circle.fill" : "mic.circle")
        }
    }
}
