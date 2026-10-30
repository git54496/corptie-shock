export function handleNativeCodexSessionHttpRequest({ request, response, url, reader, continuation, readJson, sendJson }) {
  if (!url.pathname.startsWith("/native-codex/sessions")) return false;
  // 本机其他应用的历史仅开放给桌面用户，不透传给远程 Gateway 或 Agent。
  if (request.headers.origin || request.headers["x-corptie-agent-id"]
    || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress)) {
    sendJson(response, 403, { code: "LOCAL_USER_REQUIRED", error: "仅允许本机桌面访问 Codex 会话。" });
    return true;
  }
  const execution = url.pathname.match(/^\/native-codex\/sessions\/([^/]+)\/(execution|messages|stop|approval|input|acknowledge)$/);
  const mutation = execution && execution[2] !== "execution" && request.method === "POST";
  if (request.method !== "GET" && !mutation) {
    sendJson(response, 405, { code: "METHOD_NOT_ALLOWED", error: "此 Codex 会话接口不支持该请求方法。" });
    return true;
  }
  if (execution && continuation && (mutation || execution[2] === "execution")) {
    Promise.resolve().then(async () => {
      const id = decodeURIComponent(execution[1]);
      if (!mutation) return continuation.snapshot(id);
      const input = await readJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw Object.assign(new Error("请求内容必须为 JSON 对象。"), { statusCode: 400, code: "INVALID_NATIVE_REQUEST" });
      }
      return execution[2] === "messages" ? continuation.send(id, input) : continuation.command(id, execution[2], input);
    }).then(result => sendJson(response, 200, result))
      .catch(error => sendJson(response, error.statusCode ?? 503, { code: error.code ?? "NATIVE_CONTINUATION_FAILED",
        error: error.statusCode ? error.message : "Codex 续聊操作失败，请刷新状态核对结果。" }));
    return true;
  }
  const match = url.pathname.match(/^\/native-codex\/sessions\/([^/]+)\/history$/);
  if (url.pathname !== "/native-codex/sessions" && !match) return false;
  Promise.resolve().then(() => match
    ? reader.history(decodeURIComponent(match[1]), { cursor: url.searchParams.get("cursor") })
    : reader.list({ cursor: url.searchParams.get("cursor"), search: url.searchParams.get("search") ?? "",
      archived: url.searchParams.get("archived") === "true" }))
    .then(result => sendJson(response, 200, result))
    .catch(error => sendJson(response, error.statusCode ?? 503, {
      code: error.code ?? "CODEX_READ_FAILED",
      error: error.statusCode ? error.message : "无法读取本机 Codex 历史，请检查目录权限后重试。"
    }));
  return true;
}
