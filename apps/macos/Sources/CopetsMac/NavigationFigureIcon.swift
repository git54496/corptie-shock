import SwiftUI

/// 主导航使用平面符号：未选中描边，选中填充或加重，颜色跟随系统外观。
struct NavigationFigureIcon: View {
    let id: String
    let selected: Bool

    // 每个入口分别定义两种状态，不使用透视、厚度或悬浮位移。
    private var symbols: (outline: String, filled: String) {
        switch id {
        case "console": ("house", "house.fill")
        case "automations": ("clock", "clock.fill")
        case "scenes": ("square.stack", "square.stack.fill")
        case "worktrees": ("arrow.triangle.branch", "arrow.triangle.branch")
        case "resources": ("folder", "folder.fill")
        case "agents": ("person.2", "person.2.fill")
        case "memory": ("archivebox", "archivebox.fill")
        case "codexHistory": ("text.bubble", "text.bubble.fill")
        case "settings": ("slider.horizontal.3", "slider.horizontal.3")
        default: ("square", "square.fill")
        }
    }

    var body: some View {
        Image(systemName: selected ? symbols.filled : symbols.outline)
            .font(.system(size: 21, weight: selected ? .semibold : .regular))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(selected ? Color.primary : Color.secondary)
            .frame(width: 44, height: 44)
            .accessibilityHidden(true)
    }
}
