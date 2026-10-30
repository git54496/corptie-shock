import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NativeCodexSessionReader } from "../src/application/nativeCodexSessionReader.mjs";
import { handleNativeCodexSessionHttpRequest } from "../src/application/nativeCodexSessionHttpApi.mjs";

const message = (text, role = "user") => ({ type: "response_item", timestamp: "2026-10-30T00:00:00Z",
  payload: { type: "message", role, content: [{ type: "input_text", text }] } });
const jsonl = records => records.map(record => JSON.stringify(record)).join("\n") + "\n";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "corptie-codex-reader-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "sessions"));
  await mkdir(join(home, "archived_sessions"));
  const path = join(home, "state_5.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, source TEXT,
    created_at INTEGER, updated_at INTEGER, archived INTEGER, rollout_path TEXT)`);
  db.close();
  const reader = new NativeCodexSessionReader({ home: () => home });
  async function add(id, records, { archived = false, title = id, updated = 100, rollout } = {}) {
    const file = rollout ?? join(home, archived ? "archived_sessions" : "sessions", `${id}.jsonl`);
    if (!rollout) await writeFile(file, jsonl(records));
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO threads VALUES (?, ?, NULL, '/repo', 'vscode', 1, ?, ?, ?)")
      .run(id, title, updated, Number(archived), file);
    db.close();
    return file;
  }
  return { home, path, reader, add };
}

test("native index supports search, archive filtering and stable tied-time pagination without writes", async t => {
  const f = await fixture(t);
  await f.add("a", [], { title: "100%_中文" });
  await f.add("b", []);
  await f.add("c", [], { archived: true });
  const original = await readFile(f.path);
  const first = await f.reader.list({ limit: 1 });
  assert.deepEqual(first.sessions.map(s => s.id), ["b"]);
  const second = await f.reader.list({ limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map(s => s.id), ["a"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await f.reader.list({ search: "%_" })).sessions.map(s => s.id), ["a"]);
  assert.deepEqual((await f.reader.list({ archived: true })).sessions.map(s => s.id), ["c"]);
  await assert.rejects(f.reader.list({ archived: true, cursor: first.nextCursor }), { code: "INVALID_CODEX_CURSOR" });
  await assert.rejects(f.reader.list({ cursor: "broken" }), { code: "INVALID_CODEX_CURSOR" });
  assert.deepEqual(await readFile(f.path), original);
});

test("history presents user, assistant and tool records without duplicate events or hidden instructions", async t => {
  const f = await fixture(t);
  const path = await f.add("thread", [
    message("hidden-system", "system"), message("hidden-developer", "developer"), message("你好"),
    { type: "event_msg", payload: { type: "user_message", message: "你好" } },
    { type: "response_item", payload: { type: "function_call", name: "exec", arguments: "pwd" } },
    { type: "response_item", payload: { type: "function_call_output", output: "repo" } },
    { type: "response_item", payload: { type: "reasoning", encrypted_content: "secret" } },
    message("完成", "assistant")
  ]);
  const original = await readFile(path);
  const history = await f.reader.history("thread");
  assert.deepEqual(history.items.map(item => item.text), ["你好", "pwd", "repo", "完成"]);
  assert.deepEqual(history.items.map(item => item.kind), ["user", "tool", "tool", "assistant"]);
  assert.equal(history.nextCursor, null);
  assert.deepEqual(await readFile(path), original);
});

test("reverse byte pagination preserves multibyte and large records across chunks and concurrent appends", async t => {
  const f = await fixture(t);
  const texts = ["首条", "中".repeat(50_000), "最后一条"];
  const path = await f.add("thread", texts.map(text => message(text)));
  const first = await f.reader.history("thread", { limit: 1 });
  assert.equal(first.items[0].text, texts[2]);
  await appendFile(path, jsonl([message("新消息")]));
  const second = await f.reader.history("thread", { limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].text, texts[1]);
  const third = await f.reader.history("thread", { limit: 1, cursor: second.nextCursor });
  assert.equal(third.items[0].text, texts[0]);
  assert.equal(third.nextCursor, null);
  assert.equal((await f.reader.history("thread", { limit: 1 })).items[0].text, "新消息");
  await writeFile(path, "");
  await assert.rejects(f.reader.history("thread", { cursor: first.nextCursor }), { code: "CODEX_HISTORY_CHANGED" });
});

test("empty files, no trailing newline, incomplete JSON and archived history remain readable", async t => {
  const f = await fixture(t);
  const path = await f.add("archived", [message("old")], { archived: true });
  await appendFile(path, '{"type":');
  const history = await f.reader.history("archived");
  assert.equal(history.skippedRecords, 1);
  assert.equal(history.items[0].text, "old");
  assert.equal(history.session.archived, true);
  await writeFile(path, JSON.stringify(message("no newline")));
  assert.equal((await f.reader.history("archived")).items[0].text, "no newline");
  await writeFile(path, "\n");
  assert.deepEqual((await f.reader.history("archived")).items, []);
  await writeFile(path, "");
  assert.deepEqual((await f.reader.history("archived")).items, []);
});

test("multiple history pages cover every visible message once despite intervening provider events", async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 230 }, (_, i) => [message(`message ${i}`),
    { type: "event_msg", payload: { type: "token_count" } }]).flat();
  await f.add("long", records);
  let cursor = null;
  let items = [];
  do {
    const page = await f.reader.history("long", { cursor });
    items = [...page.items, ...items];
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(items.map(item => item.text), Array.from({ length: 230 }, (_, i) => `message ${i}`));
  assert.equal(new Set(items.map(item => item.id)).size, 230);
});

test("missing index and missing files are explicit, arbitrary paths and symlinks are rejected", async t => {
  const f = await fixture(t);
  await f.add("outside", [], { rollout: f.path });
  await assert.rejects(f.reader.history("outside"), { code: "CODEX_HISTORY_OUTSIDE_HOME" });
  const link = join(f.home, "sessions", "linked.jsonl");
  await symlink(f.path, link);
  await f.add("linked", [], { rollout: link });
  await assert.rejects(f.reader.history("linked"), { code: "CODEX_HISTORY_OUTSIDE_HOME" });
  await f.add("missing", [], { rollout: join(f.home, "sessions", "missing") });
  await assert.rejects(f.reader.history("missing"), { code: "CODEX_HISTORY_UNAVAILABLE" });
  await assert.rejects(f.reader.history("unknown"), { code: "CODEX_SESSION_NOT_FOUND" });
  await rm(f.path);
  assert.equal((await f.reader.list()).available, false);
});

test("browser API is local-only and routes list and history separately", async () => {
  const calls = [];
  const reader = { list: async input => { calls.push(input); return { sessions: [] }; },
    history: async id => { calls.push(id); return { items: [] }; } };
  function dispatch(path, { method = "GET", address = "127.0.0.1", headers = {} } = {}) {
    let complete;
    const result = new Promise(resolve => { complete = resolve; });
    const handled = handleNativeCodexSessionHttpRequest({
      request: { method, headers, socket: { remoteAddress: address } }, response: {},
      url: new URL(path, "http://localhost"), reader,
      sendJson: (_, status, body) => complete({ status, body })
    });
    return { handled, result };
  }
  assert.equal((await dispatch("/native-codex/sessions?search=hello&archived=true").result).status, 200);
  assert.equal(calls[0].search, "hello");
  assert.equal(calls[0].archived, true);
  assert.equal((await dispatch("/native-codex/sessions/id/history").result).status, 200);
  assert.equal(calls[1], "id");
  for (const options of [{ address: "10.1.1.1" }, { headers: { origin: "http://example.com" } },
    { headers: { "x-corptie-agent-id": "agent" } }]) {
    assert.equal((await dispatch("/native-codex/sessions", options).result).status, 403);
  }
  assert.equal((await dispatch("/native-codex/sessions", { method: "POST" }).result).status, 405);
  assert.equal(calls.length, 2);
  assert.equal(dispatch("/sessions").handled, false);
});

test("continuation snapshot observes the latest turn marker and freezes the previous history boundary", async t => {
  const f = await fixture(t);
  const event = (type, turn_id) => ({ type: "event_msg", payload: { type, turn_id } });
  const path = await f.add("thread", [event("task_started", "first"), message("First"), event("task_complete", "first")]);
  const before = await f.reader.continuationSnapshot("thread");
  assert.equal(before.activity.state, "completed");
  assert.equal(before.activity.turnId, "first");
  await appendFile(path, jsonl([event("task_started", "second"), message("Second")]));
  assert.equal((await f.reader.continuationSnapshot("thread")).activity.state, "running");
  assert.deepEqual((await f.reader.history("thread", { cursor: before.historyCursor })).items.map(item => item.text), ["First"]);
  await appendFile(path, jsonl([event("turn_aborted", "second")]));
  assert.equal((await f.reader.continuationSnapshot("thread")).activity.state, "interrupted");
  await f.add("without-marker", [message("Uncertain")]);
  assert.equal((await f.reader.continuationSnapshot("without-marker")).activity.state, "unknown");
});

test("continuation HTTP routes reject remote/browser/Agent mutations and malformed bodies", async () => {
  const calls = [];
  const continuation = Object.fromEntries(["send", "snapshot", "command"].map(method => [method, async (...args) => {
    calls.push({ method, args }); return { run: null };
  }]));
  function dispatch(action, { method = "POST", headers = {}, address = "127.0.0.1", input = {} } = {}) {
    return new Promise(resolve => {
      const handled = handleNativeCodexSessionHttpRequest({
        request: { method, headers, socket: { remoteAddress: address } }, response: {},
        url: new URL(`/native-codex/sessions/original/${action}`, "http://localhost"), continuation,
        readJson: async () => input, sendJson: (_, status, body) => resolve({ status, body })
      });
      if (!handled) resolve({ status: 404 });
    });
  }
  for (const options of [{ address: "10.1.1.1" }, { headers: { origin: "http://localhost" } },
    { headers: { "x-corptie-agent-id": "agent" } }]) assert.equal((await dispatch("messages", options)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await dispatch("messages", { input: null })).status, 400);
  assert.equal((await dispatch("messages", { input: [] })).status, 400);
  assert.equal((await dispatch("execution")).status, 405);
  assert.equal((await dispatch("messages", { method: "GET" })).status, 404);
  assert.equal((await dispatch("execution", { method: "GET" })).status, 200);
  assert.equal((await dispatch("messages", { input: { message: "Continue", requestId: "id" } })).status, 200);
  for (const action of ["stop", "approval", "input", "acknowledge"]) assert.equal((await dispatch(action)).status, 200);
  assert.deepEqual(calls.map(call => call.method), ["snapshot", "send", "command", "command", "command", "command"]);
  assert.deepEqual(calls[1].args, ["original", { message: "Continue", requestId: "id" }]);
  assert.equal(calls[2].args[1], "stop");
});
