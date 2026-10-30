import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
@MainActor
struct NativeCodexSessionsTests {
    @Test func switchingSessionsIgnoresAnOlderInFlightResponse() async throws {
        NativeHistoryURLProtocol.handler = { request in
            let old = request.url!.path.contains("/old/")
            return (200, Self.history(id: old ? "old" : "new", text: old ? "old text" : "new text"), old ? 0.15 : 0)
        }
        let model = makeModel()
        let old = Task { await model.loadHistory(id: "old") }
        try await Task.sleep(for: .milliseconds(30))
        await model.loadHistory(id: "new")
        await old.value
        #expect(model.items.map(\.text) == ["new text"])
        #expect(model.historyError == nil)
        #expect(!model.loadingHistory)
    }

    @Test func historyFailureDoesNotPresentThePreviousSession() async {
        NativeHistoryURLProtocol.handler = { request in
            request.url!.path.contains("/missing/")
                ? (404, #"{"error":"History unavailable"}"#, 0)
                : (200, Self.history(id: "old", text: "old text"), 0)
        }
        let model = makeModel()
        await model.loadHistory(id: "old")
        await model.loadHistory(id: "missing")
        #expect(model.items.isEmpty)
        #expect(model.historyError == "History unavailable")
        #expect(model.historyCursor == nil)
    }

    @Test func earlierPageUsesCursorAndPreservesChronologicalOrder() async {
        NativeHistoryURLProtocol.handler = { request in
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
                .first(where: { $0.name == "cursor" })?.value
            if cursor == "older" { return (200, Self.history(id: "thread", text: "first", itemID: "0"), 0) }
            return (200, Self.history(id: "thread", text: "last", itemID: "100", cursor: "older"), 0)
        }
        let model = makeModel()
        await model.loadHistory(id: "thread")
        await model.loadHistory(id: "thread", earlier: true)
        #expect(model.items.map(\.text) == ["first", "last"])
        #expect(model.historyCursor == nil)
    }

    @Test func uncertainSendRetriesTheSameRequestAndRejectsAChangedDraft() async throws {
        let recorder = NativeRequestRecorder()
        NativeHistoryURLProtocol.handler = { request in
            if request.httpMethod == "POST" {
                let body = Self.body(request)
                let count = recorder.record(body)
                if count == 1 { return (503, #"{"error":"Disconnected"}"#, 0) }
                return (200, Self.execution(id: "thread", requestID: body["requestId"]!, cursor: "boundary"), 0)
            }
            if request.url!.path.hasSuffix("/execution") { return (200, #"{"run":null}"#, 0) }
            return (200, Self.history(id: "thread", text: "previous"), 0)
        }
        let model = makeModel()
        let watch = Task { await model.watch(id: "thread") }
        defer { watch.cancel() }
        try await waitForHistory(model)
        #expect(await model.send(id: "thread", message: "Continue") == false)
        #expect(await model.send(id: "thread", message: "Changed") == false)
        #expect(recorder.values.count == 1)
        #expect(await model.send(id: "thread", message: "Continue") == true)
        #expect(recorder.values.count == 2)
        #expect(recorder.values[0]["requestId"] == recorder.values[1]["requestId"])
        #expect(model.execution?.threadId == "thread")
        #expect(model.execution?.historyCursor == "boundary")
    }

    @Test func rejectedSendAllowsCorrectingTheMessageWithANewRequest() async throws {
        let recorder = NativeRequestRecorder()
        NativeHistoryURLProtocol.handler = { request in
            if request.httpMethod == "POST" {
                let body = Self.body(request)
                if recorder.record(body) == 1 { return (400, #"{"error":"Invalid message"}"#, 0) }
                return (200, Self.execution(id: "thread", requestID: body["requestId"]!), 0)
            }
            if request.url!.path.hasSuffix("/execution") { return (200, #"{"run":null}"#, 0) }
            return (200, Self.history(id: "thread", text: "previous"), 0)
        }
        let model = makeModel()
        let watch = Task { await model.watch(id: "thread") }
        defer { watch.cancel() }
        try await waitForHistory(model)
        #expect(await model.send(id: "thread", message: "Invalid") == false)
        #expect(await model.send(id: "thread", message: "Corrected") == true)
        #expect(recorder.values.count == 2)
        #expect(recorder.values[0]["requestId"] != recorder.values[1]["requestId"])
    }

    @Test func lateSendResponseCannotReplaceAnotherSelectedSession() async throws {
        NativeHistoryURLProtocol.handler = { request in
            if request.httpMethod == "POST" {
                return (200, Self.execution(id: "old", requestID: Self.body(request)["requestId"]!), 0.15)
            }
            if request.url!.path.hasSuffix("/execution") { return (200, #"{"run":null}"#, 0) }
            let id = request.url!.path.contains("/old/") ? "old" : "new"
            return (200, Self.history(id: id, text: id), 0)
        }
        let model = makeModel()
        let oldWatch = Task { await model.watch(id: "old") }
        try await waitForHistory(model)
        let sending = Task { await model.send(id: "old", message: "Continue") }
        try await Task.sleep(for: .milliseconds(30))
        oldWatch.cancel()
        let newWatch = Task { await model.watch(id: "new") }
        defer { newWatch.cancel() }
        #expect(await sending.value == false)
        #expect(model.execution == nil)
        #expect(model.items.map(\.text) == ["new"])
        #expect(!model.executingCommand)
    }

    private func waitForHistory(_ model: NativeCodexSessionsModel) async throws {
        for _ in 0..<50 {
            if !model.items.isEmpty { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("History did not load")
    }

    nonisolated private static func body(_ request: URLRequest) -> [String: String] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let size = stream.read(&buffer, maxLength: buffer.count)
                if size <= 0 { break }
                data.append(contentsOf: buffer.prefix(size))
            }
        }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    nonisolated private static func execution(id: String, requestID: String, cursor: String? = nil) -> String {
        let run: [String: Any] = ["requestId": requestID, "threadId": id, "turnId": "turn", "state": "running",
                                  "historyCursor": cursor as Any? ?? NSNull(), "message": "Continue", "items": []]
        return String(data: try! JSONSerialization.data(withJSONObject: ["run": run]), encoding: .utf8)!
    }

    private func makeModel() -> NativeCodexSessionsModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NativeHistoryURLProtocol.self]
        return NativeCodexSessionsModel(baseURL: URL(string: "http://127.0.0.1:9999")!, session: URLSession(configuration: config))
    }

    nonisolated private static func history(id: String, text: String, itemID: String = "1", cursor: String? = nil) -> String {
        let payload: [String: Any] = [
            "session": ["id": id, "title": "title", "cwd": "/repo", "source": "vscode", "updatedAt": 1, "archived": false],
            "items": [["id": itemID, "kind": "user", "label": "用户", "text": text]],
            "nextCursor": cursor as Any? ?? NSNull(), "skippedRecords": 0
        ]
        return String(data: try! JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
    }
}

private final class NativeRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    // URLProtocol 回调跨线程执行，请求记录通过锁隔离。
    private var requests: [[String: String]] = []
    var values: [[String: String]] { lock.withLock { requests } }
    func record(_ value: [String: String]) -> Int {
        lock.withLock { requests.append(value); return requests.count }
    }
}

private final class NativeHistoryURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, String, TimeInterval))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else { return }
        let (status, body, delay) = handler(request)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
