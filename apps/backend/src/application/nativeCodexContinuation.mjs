import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CodexAppServerClient } from "../adapters/codexAppServer.mjs";
import { NativeCodexSessionReader } from "./nativeCodexSessionReader.mjs";

const error = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const active = state => ["preparing", "running", "stopping", "unknown"].includes(state);
const hash = text => createHash("sha256").update(text).digest("hex");

// 原生续聊不进入 Corptie 的受管 Agent/工具编排，不创建、复制或替换原 Thread。
export class NativeCodexContinuation {
  constructor({ home, journalPath, runtimeOptions, assertAvailable = async () => {},
    createClient = options => new CodexAppServerClient(options),
    readerForHome = home => new NativeCodexSessionReader({ home: () => home }) }) {
    Object.assign(this, { home, journalPath, runtimeOptions, assertAvailable, createClient, readerForHome });
    // 原生 Home 和 Thread 的组合是运行身份；请求日志用于阻止超时/重启后重复发送。
    this.runs = new Map();
    this.requests = new Map();
    this.clients = new Map();
    this.operations = new Map();
    this.persistence = Promise.resolve();
    this.loaded = null;
    this.loadCompleted = false;
    this.closed = false;
    // 更换 Codex 程序期间阻止新续聊，避免旧进程关闭与新请求并发。
    this.transitioningProgram = false;
  }

  async scope(id) {
    if (typeof id !== "string" || !id || id.length > 200) throw error(400, "INVALID_THREAD", "会话 ID 无效。");
    if (this.closed) throw error(503, "BACKEND_CLOSING", "服务正在关闭。");
    if (this.transitioningProgram) throw error(409, "NATIVE_PROGRAM_CHANGING", "Codex 程序正在更换，请稍后重试。");
    await this.load();
    const home = await realpath(this.home());
    return { home, id, key: hash(`${home}\n${id}`), reader: this.readerForHome(home) };
  }

  load() {
    if (!this.loaded) this.loaded = (async () => {
      let saved;
      try { saved = JSON.parse(await readFile(this.journalPath(), "utf8")); }
      catch (cause) { if (cause.code === "ENOENT") { this.loadCompleted = true; return; } throw cause; }
      if (saved.version !== 1 || !Array.isArray(saved.runs)) throw error(503, "CONTINUATION_JOURNAL_INVALID", "续聊请求记录不可用，已阻止重复发送。");
      for (const stored of saved.runs) {
        const run = { ...stored, state: active(stored.state) ? "unknown" : stored.state, items: [], historyCursor: null,
          ...(active(stored.state) ? { error: "服务已重启，上一轮结果尚未确认；请在 Codex 中核对。" } : {}) };
        this.runs.set(run.key, run);
        this.requests.set(`${run.key}:${run.requestId}`, run);
      }
      this.loadCompleted = true;
    })();
    return this.loaded;
  }

  save() {
    const value = JSON.stringify({ version: 1, runs: [...this.requests.values()].map(({ items, message, historyCursor, streamItems, ...run }) => run) });
    const operation = this.persistence.catch(() => {}).then(async () => {
      const path = this.journalPath();
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, path);
    });
    this.persistence = operation;
    return operation;
  }

  clientFor(scope) {
    if (this.closed) throw error(503, "BACKEND_CLOSING", "服务正在关闭。");
    if (this.transitioningProgram) throw error(409, "NATIVE_PROGRAM_CHANGING", "Codex 程序正在更换，请稍后重试。");
    let client = this.clients.get(scope.home);
    if (!client) {
      if (this.clients.size >= 4) throw error(409, "NATIVE_ENVIRONMENT_LIMIT", "打开的本机 Codex 环境过多，请重启后重试。");
      client = this.createClient({ ...this.runtimeOptions(scope.home),
        onNotification: message => this.notification(scope.home, message),
        unboundDynamicToolError: "此工具由 Codex App 提供，Corptie 无法执行。请使用本机 shell/MCP 能力，或告知用户回到 Codex App 完成该操作。"
      });
      this.clients.set(scope.home, client);
    }
    return client;
  }

  notification(home, message) {
    const id = message.params?.threadId;
    if (!id) return;
    const run = this.runs.get(hash(`${home}\n${id}`));
    if (!run || !active(run.state)) return;
    const client = this.clients.get(home);
    if (client?.notifications.length > 512) client.notifications.splice(0, client.notifications.length - 512);
    if (message.method.startsWith("corptie/codexUserInput") && message.params.item) {
      run.streamItems ??= new Map();
      run.streamItems.set(message.params.item.id, message.params.item);
      return;
    }
    if (message.method === "item/agentMessage/delta" || message.method === "item/commandExecution/outputDelta") {
      if (run.turnId && message.params.turnId !== run.turnId) return;
      const itemId = message.params.itemId;
      if (typeof itemId !== "string" || typeof message.params.delta !== "string") return;
      run.streamItems ??= new Map();
      const previous = run.streamItems.get(itemId);
      run.streamItems.set(itemId, { id: itemId, turnId: message.params.turnId,
        type: message.method === "item/agentMessage/delta" ? "agentMessage" : "commandExecution",
        title: message.method === "item/agentMessage/delta" ? "Codex" : "Command",
        text: (previous?.text ?? "") + message.params.delta, status: "inProgress" });
      return;
    }
    if (message.method === "item/completed") {
      run.streamItems?.delete(message.params.item?.id);
      if (message.params.item?.type === "warning") {
        run.streamItems ??= new Map();
        run.streamItems.set(message.params.item.id, { ...message.params.item, turnId: message.params.turnId });
      }
    }
    if (message.method === "turn/started") {
      run.turnId = message.params.turn?.id ?? null;
      run.state = "running";
    } else if (message.method === "turn/completed" && (!run.turnId || run.turnId === message.params.turn?.id)) {
      run.turnId = message.params.turn?.id ?? run.turnId;
      run.state = { completed: "completed", interrupted: "interrupted", failed: "failed" }[message.params.turn?.status] ?? "failed";
      run.error = message.params.turn?.error?.message ?? null;
    } else return;
    run.updatedAt = new Date().toISOString();
    // 通知持久化失败必须暴露不确定状态，不能让客户端认为可以安全重发。
    void this.save().catch(() => { run.state = "unknown"; run.error = "续聊状态保存失败，请核对 Codex 中的执行结果。"; });
  }

  async snapshot(id) {
    const scope = await this.scope(id);
    const run = this.runs.get(scope.key);
    if (!run) return { run: null };
    const client = this.clients.get(scope.home);
    if (active(run.state) && run.state !== "preparing" && !client?.transport?.initialized) {
      run.state = "unknown";
      run.error = "与 Codex 的连接已断开，请核对执行结果后再继续。";
    }
    if (run.state === "unknown") {
      const native = await scope.reader.continuationSnapshot(id);
      if (run.turnId && native.activity.turnId === run.turnId && ["completed", "interrupted"].includes(native.activity.state)) {
        run.state = native.activity.state;
        run.error = null;
        run.historyCursor = null;
        await this.save();
      }
    }
    // 终态通知可能先于落盘；确认原始日志已包含该轮后，再移除实时层并恢复完整历史。
    if (!active(run.state) && run.historyCursor && run.turnId) {
      const native = await scope.reader.continuationSnapshot(id).catch(() => null);
      if (native?.activity.turnId === run.turnId && ["completed", "interrupted"].includes(native.activity.state)) {
        run.historyCursor = null;
        run.streamItems = null;
      }
    }
    return { run: this.present(run, client) };
  }

  present(run, client) {
    const merged = new Map((client?.liveItemsForThread(run.threadId) ?? []).map(item => [item.id, item]));
    for (const [id, item] of run.streamItems ?? []) merged.set(id, item);
    const items = run.historyCursor ? [...merged.values()].filter(item => !run.turnId || item.turnId === run.turnId) : [];
    return { requestId: run.requestId, threadId: run.threadId, turnId: run.turnId, state: run.state,
      error: run.error ?? null, historyCursor: run.historyCursor, message: run.message ?? null,
      items: items.map(item => ({ id: item.id, type: item.type, text: item.text ?? "", title: item.title ?? "",
        status: item.status ?? null, options: item.options ?? null,
        userInput: item.type === "userInput" ? parseUserInput(item) : null })) };
  }

  async send(id, input = {}) {
    const scope = await this.scope(id);
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message || message.length > 100_000 || !/^[a-zA-Z0-9-]{16,100}$/.test(input.requestId ?? "")) {
      throw error(400, "INVALID_NATIVE_MESSAGE", "请输入消息并提供有效请求标识。");
    }
    const previous = this.requests.get(`${scope.key}:${input.requestId}`);
    if (previous) {
      if (previous.messageHash !== hash(message)) throw error(409, "REQUEST_ID_CONFLICT", "同一请求标识不能发送不同消息。");
      return { run: this.present(previous, this.clients.get(scope.home)) };
    }
    const current = this.runs.get(scope.key);
    if (this.operations.has(scope.key) || (current && active(current.state))) {
      throw error(409, "NATIVE_SESSION_BUSY", "此会话仍在执行或结果尚未确认，请先等待、停止或核对上一轮。");
    }
    const operation = this.start(scope, input.requestId, message);
    this.operations.set(scope.key, operation);
    try { return await operation; }
    finally { if (this.operations.get(scope.key) === operation) this.operations.delete(scope.key); }
  }

  async start(scope, requestId, message) {
    await this.assertAvailable(scope.id, scope.home);
    const native = await scope.reader.continuationSnapshot(scope.id);
    assertIdle(native);
    if (!native.session.cwd || !(await stat(native.session.cwd)).isDirectory()) {
      throw error(409, "NATIVE_WORKSPACE_UNAVAILABLE", "原会话工作目录不可用，请在 Codex 中修复后重试。");
    }
    const run = { key: scope.key, home: scope.home, threadId: scope.id, requestId, messageHash: hash(message),
      message, state: "preparing", turnId: null, historyCursor: native.historyCursor, items: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.runs.set(scope.key, run);
    this.requests.set(`${scope.key}:${requestId}`, run);
    // 在可能被 Codex 接受之前写入请求标识；超时不会自动重新投递。
    try { await this.save(); }
    catch (cause) { run.state = "failed"; throw cause; }
    let attemptedTurn = false;
    try {
      const client = this.clientFor(scope);
      await client.initialize();
      const read = await client.request("thread/read", { threadId: scope.id, includeTurns: false });
      if (read.thread?.id !== scope.id) throw error(409, "NATIVE_IDENTITY_MISMATCH", "Codex 返回了不同的会话。");
      if (read.thread.status?.type === "active") throw error(409, "NATIVE_SESSION_BUSY", "Codex 中的会话仍在执行。");
      // 原生 Goal 可能在恢复时自动续跑。先要求暂停，确保本次只发送用户输入。
      try {
        const result = await client.request("thread/goal/get", { threadId: scope.id });
        if (result.goal?.status === "active") throw error(409, "NATIVE_GOAL_ACTIVE", "请先在 Codex 中暂停该会话的 Goal，再从 Corptie 续聊。");
      } catch (cause) { if (!/method not found|unknown variant|unknown method/i.test(cause.message ?? "")) throw cause; }
      if (native.session.archived) await client.unarchiveThread(scope.id);
      // 每次恢复前卸载自己持有的空闲实例，使 Codex App 新增的历史也能被重新加载。
      if (client.threadResumeFingerprints?.has(scope.id)) await client.unsubscribeThread(scope.id);
      const resumed = await client.resumeThread(scope.id);
      if (resumed.thread?.id !== scope.id) throw error(409, "NATIVE_IDENTITY_MISMATCH", "恢复后的会话 ID 不匹配。");
      const latest = await scope.reader.continuationSnapshot(scope.id);
      assertIdle(latest);
      if (latest.activity.turnId !== native.activity.turnId) throw error(409, "NATIVE_HISTORY_CHANGED", "Codex 中的会话发生了变化，请刷新历史再发送。");
      client.liveThreadCache?.releaseThread(scope.id);
      run.historyCursor = latest.historyCursor;
      if (this.closed) throw error(503, "BACKEND_CLOSING", "服务正在关闭。");
      attemptedTurn = true;
      const result = await client.startTurn(scope.id, message);
      if (!result.turn?.id) throw error(503, "NATIVE_TURN_UNCONFIRMED", "Codex 未返回轮次标识，请核对结果。");
      run.turnId = result.turn.id;
      if (run.state === "preparing") run.state = "running";
      await this.save();
      return { run: this.present(run, client) };
    } catch (cause) {
      // turn/start 的失败可能发生在远端已接收之后，保守保留，不自动重发。
      if (active(run.state)) run.state = attemptedTurn ? "unknown" : "failed";
      if (!attemptedTurn) run.historyCursor = null;
      run.error = cause.statusCode ? cause.message : attemptedTurn
        ? "发送结果尚未确认，请先核对 Codex 会话，勿重复发送。"
        : "无法恢复原 Codex 会话，请检查 Codex 登录、程序版本和工具配置。";
      await this.save();
      return { run: this.present(run, this.clients.get(scope.home)) };
    }
  }

  async command(id, action, input) {
    const scope = await this.scope(id);
    const run = this.runs.get(scope.key);
    if (!run || input.requestId !== run.requestId) throw error(409, "NATIVE_RUN_CHANGED", "当前轮次已改变，请刷新后重试。");
    if (action === "acknowledge") {
      if (run.state !== "unknown" || input.confirmed !== true) throw error(409, "NATIVE_ACK_REQUIRED", "请先核对 Codex 中的执行状态。");
      const native = await scope.reader.continuationSnapshot(id);
      assertIdle(native);
      run.state = "interrupted";
      run.error = null;
      run.historyCursor = null;
      await this.save();
      return this.snapshot(id);
    }
    const client = this.clients.get(scope.home);
    if (!client?.transport?.initialized || !["running", "stopping"].includes(run.state) || !run.turnId) {
      throw error(409, "NATIVE_RUN_NOT_ACTIVE", "当前没有可控制的执行轮次。");
    }
    if (action === "stop") {
      await client.interruptTurn(id, run.turnId);
      if (run.state === "running") run.state = "stopping";
    } else if (action === "approval") {
      if (typeof input.itemId !== "string" || typeof input.approved !== "boolean") throw error(400, "INVALID_APPROVAL", "审批参数无效。");
      await client.respondToApproval(id, { itemId: input.itemId, approved: input.approved, optionId: input.optionId });
    } else if (action === "input") {
      await client.respondToUserInput(id, input);
    } else throw error(404, "UNKNOWN_NATIVE_ACTION", "不支持此操作。");
    await this.save();
    return this.snapshot(id);
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.clients.values()].map(client => client.close()));
    for (const run of this.runs.values()) if (active(run.state)) run.state = "unknown";
    if (this.loadCompleted) await this.save();
  }

  runningPrograms() {
    return [...this.clients.entries()].flatMap(([home, client]) => {
      const transport = client.transport;
      return transport?.process && transport.runningCommand ? [{ profileId: `native-continuation:${hash(home)}`,
        path: transport.runningCommand, pid: transport.process.pid, initialized: transport.initialized }] : [];
    });
  }

  async releaseIdleClients() {
    if (this.operations.size || [...this.runs.values()].some(run => active(run.state))) {
      throw error(409, "NATIVE_SESSION_BUSY", "原生 Codex 续聊尚未结束，请先停止并确认执行结果后再更改程序。");
    }
    await Promise.all([...this.clients.values()].map(client => client.close()));
    this.clients.clear();
    for (const run of this.runs.values()) { run.historyCursor = null; run.streamItems = null; }
  }

  async withExecutableTransition(operation) {
    if (this.transitioningProgram) throw error(409, "NATIVE_PROGRAM_CHANGING", "Codex 程序正在更换，请稍后重试。");
    this.transitioningProgram = true;
    try { await this.releaseIdleClients(); return await operation(); }
    finally { this.transitioningProgram = false; }
  }
}

function assertIdle(native) {
  if (!["completed", "interrupted"].includes(native.activity.state)) {
    throw error(409, "NATIVE_SESSION_BUSY", "原会话仍在执行，或无法确认已结束。请先在 Codex 中结束当前轮次再续聊。");
  }
}

function parseUserInput(item) {
  try { return JSON.parse(item.rawMetadataJSON ?? "{}").userInput ?? null; }
  catch { return null; }
}
