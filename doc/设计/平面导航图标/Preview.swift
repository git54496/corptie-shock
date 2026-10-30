import SwiftUI
import AppKit

@main
struct NavigationIconPreview {
    @MainActor static func main() throws {
        let entries = [("console", "工作台"), ("automations", "自动化"), ("scenes", "场景"),
                       ("worktrees", "Worktrees"), ("resources", "资源"), ("agents", "Agents"),
                       ("memory", "记忆"), ("codexHistory", "会话"), ("settings", "设置")]
        let gallery = VStack(spacing: 0) {
            ForEach([false, true], id: \.self) { dark in
                VStack(alignment: .leading, spacing: 20) {
                    Text(dark ? "DARK / 平面导航 · 描边 / 选中" : "LIGHT / 平面导航 · 描边 / 选中").font(.system(size: 13, weight: .medium))
                    HStack(spacing: 24) {
                        ForEach(entries, id: \.0) { id, name in
                            VStack(spacing: 12) {
                                NavigationFigureIcon(id: id, selected: false)
                                Text(name).font(.system(size: 11))
                                NavigationFigureIcon(id: id, selected: true)
                                    .background {
                                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                                            .fill(Color.primary.opacity(0.07))
                                    }
                            }.frame(width: 64)
                        }
                    }
                }
                .padding(32).foregroundStyle(.primary)
                .background(dark ? Color(nsColor: .windowBackgroundColor) : Color.white)
                .environment(\.colorScheme, dark ? .dark : .light)
            }
        }
        let renderer = ImageRenderer(content: gallery)
        renderer.scale = 2
        guard let image = renderer.cgImage else { fatalError("Preview render failed") }
        let bitmap = NSBitmapImageRep(cgImage: image)
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
    }
}
