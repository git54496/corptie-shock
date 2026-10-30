import SwiftUI

struct NativeCodexSession: Decodable, Identifiable {
    let id: String
    let title: String
    let cwd: String
    let source: String
    let updatedAt: Double
    let archived: Bool
}

struct NativeCodexHistoryItem: Decodable, Identifiable {
    let id: String
    let kind: String
    let label: String
    let text: String
    let timestamp: String?
}

private struct NativeCodexReadFailure: Decodable { let error: String }
private struct NativeCodexHTTPError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

struct NativeCodexExecution: Decodable {
    let requestId: String
    let threadId: String
    let turnId: String?
    let state: String
    let error: String?
    let historyCursor: String?
    let message: String?
    let items: [NativeCodexLiveItem]
    var isActive: Bool { ["preparing", "running", "stopping", "unknown"].contains(state) }
}

struct NativeCodexLiveItem: Decodable, Identifiable {
    struct Option: Decodable, Identifiable { let id: String; let label: String; let role: String }
    struct Input: Decodable {
        struct Question: Decodable, Identifiable {
            struct Choice: Decodable { let label: String; let description: String }
            let id: String
            let question: String
            let isSecret: Bool?
            let isOther: Bool?
            let required: Bool?
            let options: [Choice]?
        }
        let questions: [Question]
        let url: String?
        let canCancel: Bool?
    }
    let id: String
    let type: String
    let text: String
    let title: String
    let status: String?
    let options: [Option]?
    let userInput: Input?
}

private struct NativeCodexExecutionEnvelope: Decodable { let run: NativeCodexExecution? }

private struct NativeCodexSessionPage: Decodable {
    let home: String
    let available: Bool
    let sessions: [NativeCodexSession]
    let nextCursor: String?
}

private struct NativeCodexHistoryPage: Decodable {
    let session: NativeCodexSession
    let items: [NativeCodexHistoryItem]
    let nextCursor: String?
    let skippedRecords: Int
}

@MainActor
final class NativeCodexSessionsModel: ObservableObject {
    // 浏览数据与分页状态仅保留在界面内存中，不写入 Corptie 受管会话。
    @Published private(set) var sessions: [NativeCodexSession] = []
    @Published private(set) var items: [NativeCodexHistoryItem] = []
    @Published private(set) var home = ""
    @Published private(set) var available = true
    @Published private(set) var listCursor: String?
    @Published private(set) var historyCursor: String?
    @Published private(set) var listError: String?
    @Published private(set) var historyError: String?
    @Published private(set) var skippedRecords = 0
    @Published private(set) var loadingList = false
    @Published private(set) var loadingHistory = false
    @Published private(set) var execution: NativeCodexExecution?
    @Published private(set) var executionError: String?
    @Published private(set) var executingCommand = false
    // 草稿请求标识保留到投递结果已知，网络重试始终使用同一标识。
    private var pendingSends: [String: (requestId: String, message: String)] = [:]
    private var selectedThreadID: String?
    private var commandGeneration = UUID()
    // 请求代次防止快速切换会话、筛选或刷新时旧响应覆盖当前页面。
    private var listGeneration = UUID()
    private var historyGeneration = UUID()
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = CorptieAppEnvironment.backendBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func loadList(search: String, archived: Bool, append: Bool = false) async {
        let generation = UUID()
        listGeneration = generation
        let cursor = append ? listCursor : nil
        if !append { sessions = []; listCursor = nil }
        loadingList = true
        listError = nil
        defer { if generation == listGeneration { loadingList = false } }
        do {
            if !append { try await Task.sleep(for: .milliseconds(200)) }
            let page: NativeCodexSessionPage = try await get("native-codex/sessions", query: [
                URLQueryItem(name: "search", value: search),
                URLQueryItem(name: "archived", value: String(archived)),
                URLQueryItem(name: "cursor", value: cursor)
            ])
            try Task.checkCancellation()
            guard generation == listGeneration else { return }
            home = page.home
            available = page.available
            let existing = Set(sessions.map(\.id))
            sessions += page.sessions.filter { !existing.contains($0.id) }
            listCursor = page.nextCursor
        } catch {
            if generation == listGeneration && !Task.isCancelled { listError = error.localizedDescription }
        }
    }

    func loadHistory(id: String?, earlier: Bool = false) async {
        let generation = UUID()
        historyGeneration = generation
        let cursor = earlier ? historyCursor : execution?.historyCursor
        if !earlier { items = []; historyCursor = nil; skippedRecords = 0 }
        historyError = nil
        loadingHistory = id != nil
        defer { if generation == historyGeneration { loadingHistory = false } }
        guard let id else { return }
        do {
            let page: NativeCodexHistoryPage = try await get("native-codex/sessions/\(id)/history", query: [
                URLQueryItem(name: "cursor", value: cursor)
            ])
            try Task.checkCancellation()
            guard generation == historyGeneration else { return }
            let existing = Set(items.map(\.id))
            items = page.items.filter { !existing.contains($0.id) } + items
            historyCursor = page.nextCursor
            skippedRecords += page.skippedRecords
        } catch {
            if generation == historyGeneration && !Task.isCancelled { historyError = error.localizedDescription }
        }
    }

    func watch(id: String?) async {
        selectedThreadID = id
        commandGeneration = UUID()
        executingCommand = false
        execution = nil
        executionError = nil
        if let id { await refreshExecution(id: id) }
        guard !Task.isCancelled, selectedThreadID == id else { return }
        await loadHistory(id: id)
        guard let id else { return }
        while !Task.isCancelled && selectedThreadID == id {
            do { try await Task.sleep(for: .milliseconds(execution?.isActive == true ? 700 : 2500)) }
            catch { return }
            let previousCursor = execution?.historyCursor
            let previousRequest = execution?.requestId
            await refreshExecution(id: id)
            if !Task.isCancelled && selectedThreadID == id
                && (execution?.requestId != previousRequest || execution?.historyCursor != previousCursor) {
                await loadHistory(id: id)
            }
        }
    }

    private func refreshExecution(id: String) async {
        do {
            let result: NativeCodexExecutionEnvelope = try await get("native-codex/sessions/\(id)/execution", query: [])
            guard selectedThreadID == id, !Task.isCancelled else { return }
            execution = result.run
            executionError = nil
            if result.run?.requestId == pendingSends[id]?.requestId { pendingSends[id] = nil }
        } catch {
            if selectedThreadID == id && !Task.isCancelled { executionError = error.localizedDescription }
        }
    }

    func send(id: String, message: String) async -> Bool {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !executingCommand else { return false }
        if let pending = pendingSends[id], pending.message != text {
            executionError = L10n("上一条消息结果尚未确认，请先刷新状态或重试原消息。")
            return false
        }
        let requestID = pendingSends[id]?.requestId ?? UUID().uuidString
        pendingSends[id] = (requestID, text)
        let result = await perform(id: id, action: "messages", body: ["requestId": requestID, "message": text])
        if result { pendingSends[id] = nil }
        return result && ["running", "completed", "interrupted"].contains(execution?.state ?? "")
    }

    func command(id: String, action: String, values: [String: Any] = [:]) async {
        guard let run = execution, run.threadId == id else { return }
        _ = await perform(id: id, action: action, body: values.merging(["requestId": run.requestId]) { _, new in new })
    }

    private func perform(id: String, action: String, body: [String: Any]) async -> Bool {
        let generation = UUID()
        commandGeneration = generation
        executingCommand = true
        executionError = nil
        defer { if commandGeneration == generation { executingCommand = false } }
        do {
            let result: NativeCodexExecutionEnvelope = try await get("native-codex/sessions/\(id)/\(action)", query: [], body: body)
            guard commandGeneration == generation, selectedThreadID == id else { return false }
            let changed = execution?.historyCursor != result.run?.historyCursor
            execution = result.run
            if changed { await loadHistory(id: id) }
            return true
        } catch {
            if action == "messages", let failure = error as? NativeCodexHTTPError, (400..<500).contains(failure.status) {
                pendingSends[id] = nil
            }
            if commandGeneration == generation && selectedThreadID == id { executionError = error.localizedDescription }
            return false
        }
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem], body: [String: Any]? = nil) async throws -> T {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.filter { $0.value != nil }
        var request = URLRequest(url: components.url!)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = body == nil ? 30 : 120
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(NativeCodexReadFailure.self, from: data))?.error ?? L10n("读取失败，请重试")
            throw NativeCodexHTTPError(status: http.statusCode, message: message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

struct NativeCodexSessionsView: View {
    @StateObject private var model = NativeCodexSessionsModel()
    @State private var search = ""
    @State private var archived = false
    @State private var selection: String?
    @State private var drafts: [String: String] = [:]
    @State private var confirmsUnknownRun = false

    private struct Filter: Equatable { let search: String; let archived: Bool }

    var body: some View {
        HSplitView {
            sidebar.frame(minWidth: 250, idealWidth: 300, maxWidth: 440)
            detail.frame(minWidth: 340, maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(MainWindowPageLayoutMetrics.outerPadding)
        .task(id: Filter(search: search, archived: archived)) {
            selection = nil
            await model.loadList(search: search, archived: archived)
        }
        .task(id: selection) { await model.watch(id: selection) }
        .onChange(of: model.execution?.turnId) { _, turnID in
            if turnID != nil, let run = model.execution, let message = run.message, drafts[run.threadId] == message {
                drafts[run.threadId] = ""
            }
        }
        .confirmationDialog(L10n("已在 Codex 中确认上一轮结束？"), isPresented: $confirmsUnknownRun) {
            Button(L10n("已核对，解除等待")) {
                if let selection { Task { await model.command(id: selection, action: "acknowledge", values: ["confirmed": true]) } }
            }
        } message: {
            Text(L10n("这不会重发上一条消息；请先核对执行结果，避免重复操作。"))
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L10n("Codex 会话")).font(.headline)
                Spacer()
                Button { Task { await model.loadList(search: search, archived: archived) } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help(L10n("刷新"))
                .disabled(model.loadingList)
            }
            TextField(L10n("搜索标题或工作目录"), text: $search)
                .textFieldStyle(.roundedBorder)
            Toggle(L10n("已归档"), isOn: $archived)
            if !model.home.isEmpty {
                Text(model.home).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2).textSelection(.enabled)
            }
            if let error = model.listError { errorText(error) }
            if !model.available {
                Text(L10n("未找到本机 Codex 会话索引。请先在 Codex 中创建本地会话，或检查 Codex Home 设置。"))
                    .foregroundStyle(.secondary)
            } else if model.sessions.isEmpty && !model.loadingList && model.listError == nil {
                Text(L10n("没有匹配的会话")).foregroundStyle(.secondary)
            }
            List(model.sessions, selection: $selection) { session in
                VStack(alignment: .leading, spacing: 5) {
                    Text(session.title.isEmpty ? L10n("未命名会话") : session.title).lineLimit(2)
                    if !session.cwd.isEmpty { Text(session.cwd).font(.caption).lineLimit(1).truncationMode(.middle) }
                    Text(Date(timeIntervalSince1970: session.updatedAt), style: .date)
                        .font(.caption2).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                .tag(session.id)
            }
            .listStyle(.sidebar)
            if model.loadingList { ProgressView().controlSize(.small) }
            if model.listCursor != nil {
                Button(L10n("加载更多会话")) {
                    Task { await model.loadList(search: search, archived: archived, append: true) }
                }.disabled(model.loadingList)
            }
        }
        .padding(14)
        .mainWindowPageCard()
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let session = model.sessions.first(where: { $0.id == selection }) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(session.title.isEmpty ? L10n("未命名会话") : session.title).font(.headline).lineLimit(2)
                        Text(L10n("原生 Codex 会话 · 原历史续聊")).font(.caption).foregroundStyle(.secondary)
                        if !session.cwd.isEmpty {
                            Text(session.cwd).font(.caption).lineLimit(2).textSelection(.enabled)
                        }
                        Text(session.id).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    Spacer()
                    Button(L10n("刷新历史")) { Task { await model.loadHistory(id: session.id) } }
                        .disabled(model.loadingHistory)
                }.padding(16)
                Divider()
                history.id(session.id)
                Divider()
                composer(session)
            } else {
                ContentUnavailableView(L10n("选择一个 Codex 会话"), systemImage: "text.bubble",
                    description: Text(L10n("浏览本机 Codex 保存的消息和工具记录")))
            }
        }.mainWindowPageCard()
    }

    private var history: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if model.historyCursor != nil {
                        Button(L10n("加载更早记录")) {
                            Task {
                                let anchor = model.items.first?.id
                                await model.loadHistory(id: selection, earlier: true)
                                if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                            }
                        }.disabled(model.loadingHistory)
                    }
                    if model.loadingHistory { ProgressView().controlSize(.small) }
                    if let error = model.historyError { errorText(error) }
                    if model.skippedRecords > 0 {
                        Text(L10n("部分记录尚未写完或格式无效，已跳过；可刷新重试。"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if model.items.isEmpty && !model.loadingHistory && model.historyError == nil {
                        Text(L10n("此页没有可展示的消息，可加载更早记录或刷新。"))
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.items) { item in
                        NativeCodexHistoryRow(item: item).id(item.id)
                    }
                    if let run = model.execution, run.historyCursor != nil {
                        if let message = run.message, !run.items.contains(where: { $0.type == "userMessage" }) {
                            NativeCodexHistoryRow(item: .init(id: run.requestId, kind: "user", label: "用户", text: message, timestamp: nil))
                        }
                        ForEach(run.items.filter { $0.type != "userInput" || $0.status == "pending" }) { item in
                            liveItem(item, run: run)
                        }
                    }
                    Color.clear.frame(height: 1).id("native-live-bottom")
                }.padding(20)
            }
            .onChange(of: model.items.last?.id) { _, id in
                if let id { proxy.scrollTo(id, anchor: .bottom) }
            }
            .onChange(of: model.execution?.items.last?.id) { _, _ in proxy.scrollTo("native-live-bottom", anchor: .bottom) }
        }
    }

    private func composer(_ session: NativeCodexSession) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n("保留原工作目录、模型和权限。Codex App 专属工具可能不可用；请勿在两端同时发送。"))
                .font(.caption).foregroundStyle(.secondary)
            if let message = model.executionError ?? model.execution?.error { errorText(message) }
            TextEditor(text: Binding(get: { drafts[session.id] ?? "" }, set: { drafts[session.id] = $0 }))
                .font(.body).frame(minHeight: 50, maxHeight: 100)
                .accessibilityLabel(L10n("续聊消息"))
            HStack {
                if model.executingCommand || model.execution?.isActive == true {
                    ProgressView().controlSize(.small)
                    Text(L10n(model.execution?.state == "unknown" ? "等待核对执行结果" : "Codex 正在处理"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if model.execution?.state == "unknown" {
                    Button(L10n("核对后解除等待")) { confirmsUnknownRun = true }
                        .disabled(model.executingCommand)
                } else if ["running", "stopping"].contains(model.execution?.state ?? "") {
                    Button(L10n("停止")) { Task { await model.command(id: session.id, action: "stop") } }
                        .disabled(model.executingCommand || model.execution?.state == "stopping")
                }
                Button(L10n(session.archived ? "恢复并续聊" : "发送")) {
                    let text = drafts[session.id] ?? ""
                    Task {
                        if await model.send(id: session.id, message: text), drafts[session.id] == text { drafts[session.id] = "" }
                    }
                }
                .disabled(model.executingCommand || model.execution?.isActive == true || (drafts[session.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(14)
    }

    @ViewBuilder private func liveItem(_ item: NativeCodexLiveItem, run: NativeCodexExecution) -> some View {
        if item.type == "approval", item.status == "pending", run.isActive {
            VStack(alignment: .leading, spacing: 8) {
                Text(item.text).textSelection(.enabled)
                HStack {
                    ForEach(item.options ?? []) { option in
                        Button(option.label) {
                            Task { await model.command(id: run.threadId, action: "approval", values: [
                                "itemId": item.id, "approved": option.role == "approve", "optionId": option.id
                            ]) }
                        }.disabled(model.executingCommand)
                    }
                }
            }.padding(12).background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        } else if item.type == "userInput", let input = item.userInput, run.isActive {
            NativeCodexInputForm(input: input, disabled: model.executingCommand) { answers, cancelled in
                Task { await model.command(id: run.threadId, action: "input", values: [
                    "itemId": item.id, "action": cancelled ? "cancel" : "submit", "answers": answers
                ]) }
            }.id(item.id)
        } else {
            NativeCodexHistoryRow(item: .init(id: item.id,
                kind: item.type == "agentMessage" ? "assistant" : item.type == "userMessage" ? "user" : "tool",
                label: item.title, text: item.text, timestamp: nil))
        }
    }

    private func errorText(_ value: String) -> some View {
        Text(value).foregroundStyle(.red).font(.callout).textSelection(.enabled)
    }
}

private struct NativeCodexInputForm: View {
    let input: NativeCodexLiveItem.Input
    let disabled: Bool
    let submit: ([String: [String]], Bool) -> Void
    @State private var answers: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let raw = input.url, let url = URL(string: raw), ["http", "https"].contains(url.scheme) {
                Link(L10n("打开确认页面"), destination: url)
            }
            ForEach(input.questions) { question in
                Text(question.question).font(.callout)
                let binding = Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 })
                if let options = question.options {
                    Picker(L10n("选择答案"), selection: binding) {
                        Text(L10n("请选择")).tag("")
                        ForEach(options, id: \.label) { option in Text(option.label).tag(option.label) }
                    }
                }
                if question.options == nil || question.isOther == true {
                    if question.isSecret == true { SecureField(L10n("输入答案"), text: binding) }
                    else { TextField(L10n("输入答案"), text: binding).textFieldStyle(.roundedBorder) }
                }
            }
            HStack {
                if input.canCancel == true { Button(L10n("取消")) { submit([:], true) } }
                Button(L10n("提交答案")) {
                    submit(Dictionary(uniqueKeysWithValues: input.questions.map {
                        ($0.id, answers[$0.id].map { [$0] } ?? [])
                    }), false)
                }.disabled(input.questions.contains { $0.required != false && (answers[$0.id] ?? "").isEmpty })
            }.disabled(disabled)
        }.padding(12).background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct NativeCodexHistoryRow: View {
    let item: NativeCodexHistoryItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if item.kind == "tool" {
                DisclosureGroup(item.label == "工具结果" ? L10n("工具结果") : item.label) {
                    Text(item.text).font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Text(item.kind == "user" ? L10n("用户") : "Codex").font(.caption.bold()).foregroundStyle(.secondary)
                Text(item.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .background(item.kind == "user" ? Color.accentColor.opacity(0.07) : Color.primary.opacity(0.035),
                    in: RoundedRectangle(cornerRadius: 10))
    }
}
