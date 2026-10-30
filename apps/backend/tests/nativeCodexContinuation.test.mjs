import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeCodexContinuation } from "../src/application/nativeCodexContinuation.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), "native-continuation-"));
  const journal = join(home, "journal.json");
  const calls = [];
  const source = { home, session: { id: "original", cwd: home, archived: false },
    activity: { state: "completed", turnId: "before" }, historyCursor: "original-history-boundary" };
  let client, count = 0;
  const config = {
    home: () => home, journalPath: () => journal, runtimeOptions: () => ({}),
    readerForHome: () => ({ continuationSnapshot: async () => structuredClone(source) }),
    createClient: runtimeOptions => {
      client = new CodexAppServerClient(runtimeOptions);
      client.initialize = async () => { client.transport.initialized = true; };
      client.close = async () => { client.transport.initialized = false; };
      client.request = async (method, params) => {
        calls.push({ method, params });
        if (options.fail?.(method)) throw new Error("Synthetic transport failure");
        if (method === "thread/read") return { thread: { id: "original", status: { type: "notLoaded" } } };
        if (method === "thread/goal/get") return { goal: options.goal ?? null };
        if (method === "thread/resume") return { thread: { id: "original" } };
        if (method === "turn/start") {
          const turn = { id: `turn-${++count}`, status: "inProgress" };
          client.handleNotification({ method: "turn/started", params: { threadId: "original", turn } });
          return { turn };
        }
        return {};
      };
      client.respondToServerRequest = async (id, response) => { calls.push({ method: "response", id, response }); };
      return client;
    }
  };
  const service = new NativeCodexContinuation(config);
  t.after(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  const complete = (status = "completed") => {
    source.activity = { state: status === "interrupted" ? status : "completed", turnId: `turn-${count}` };
    client.handleNotification({ method: "turn/completed", params: { threadId: "original", turn: { id: `turn-${count}`, status } } });
  };
  return { home, journal, service, config, calls, source, complete, get client() { return client; } };
}

test("continuation resumes the original thread and sends without replacing configuration or creating a thread", async t => {
  const f = await fixture(t);
  const result = await f.service.send("original", { requestId: "request-0000000001", message: "Continue" });
  assert.equal(result.run.state, "running");
  assert.equal(result.run.threadId, "original");
  const resumed = f.calls.find(call => call.method === "thread/resume");
  assert.equal(resumed.params.threadId, "original");
  for (const key of ["model", "cwd", "sandbox", "approvalPolicy", "developerInstructions", "config"]) assert.equal(resumed.params[key], undefined);
  const turn = f.calls.find(call => call.method === "turn/start");
  assert.equal(turn.params.threadId, "original");
  assert.equal(turn.params.input[0].text, "Continue");
  assert.equal(f.calls.some(call => ["thread/start", "thread/fork", "thread/delete"].includes(call.method)), false);
  assert.equal(result.run.historyCursor, "original-history-boundary");
});

test("duplicate requests are durable across later turns and restarts, and changed payloads are rejected", async t => {
  const f = await fixture(t);
  const input = { requestId: "request-0000000001", message: "First" };
  await f.service.send("original", input);
  await f.service.send("original", input);
  await assert.rejects(f.service.send("original", { ...input, message: "Changed" }), { code: "REQUEST_ID_CONFLICT" });
  await assert.rejects(f.service.send("original", { requestId: "request-0000000002", message: "Second" }), { code: "NATIVE_SESSION_BUSY" });
  f.complete();
  await f.service.send("original", { requestId: "request-0000000002", message: "Second" });
  await f.service.send("original", input);
  assert.equal(f.calls.filter(call => call.method === "turn/start").length, 2);
  await f.service.close();
  const restarted = new NativeCodexContinuation(f.config);
  await restarted.send("original", input);
  assert.equal(f.calls.filter(call => call.method === "turn/start").length, 2);
  await restarted.close();
  assert.equal((await readFile(f.journal, "utf8")).includes('"message":"'), false);
});

test("an active external turn or an active goal cannot be resumed and no destructive cleanup is performed", async t => {
  const f = await fixture(t, { goal: { status: "active" } });
  f.source.activity.state = "running";
  await assert.rejects(f.service.send("original", { requestId: "request-0000000001", message: "Wait" }), { code: "NATIVE_SESSION_BUSY" });
  assert.deepEqual(f.calls, []);
  f.source.activity.state = "completed";
  const result = await f.service.send("original", { requestId: "request-0000000001", message: "Wait" });
  assert.equal(result.run.state, "failed");
  assert.match(result.run.error, /Goal/);
  assert.equal(f.calls.some(call => ["thread/resume", "turn/start", "thread/delete", "thread/archive"].includes(call.method)), false);
});

test("timeout after turn submission remains uncertain and never retries automatically", async t => {
  const f = await fixture(t, { fail: method => method === "turn/start" });
  const input = { requestId: "request-0000000001", message: "Do once" };
  assert.equal((await f.service.send("original", input)).run.state, "unknown");
  assert.equal((await f.service.send("original", input)).run.state, "unknown");
  await assert.rejects(f.service.send("original", { ...input, requestId: "request-0000000002" }), { code: "NATIVE_SESSION_BUSY" });
  assert.equal(f.calls.filter(call => call.method === "turn/start").length, 1);
  await assert.rejects(f.service.command("original", "acknowledge", { requestId: input.requestId }), { code: "NATIVE_ACK_REQUIRED" });
  f.source.activity.state = "running";
  await assert.rejects(f.service.command("original", "acknowledge", { requestId: input.requestId, confirmed: true }), { code: "NATIVE_SESSION_BUSY" });
  f.source.activity.state = "completed";
  assert.equal((await f.service.command("original", "acknowledge", { requestId: input.requestId, confirmed: true })).run.state, "interrupted");
});

test("live deltas, approval, question answers and stop target the exact pending native run", async t => {
  const f = await fixture(t);
  const requestId = "request-0000000001";
  await f.service.send("original", { requestId, message: "Continue" });
  f.client.handleNotification({ method: "item/agentMessage/delta", params: { threadId: "original", turnId: "turn-1", itemId: "answer", delta: "Hello" } });
  assert.ok((await f.service.snapshot("original")).run.items.some(item => item.text === "Hello"));
  f.client.handleServerRequest({ id: 11, method: "item/commandExecution/requestApproval", params: {
    threadId: "original", turnId: "turn-1", command: "echo test", availableDecisions: ["accept", "decline"]
  } });
  const approval = (await f.service.snapshot("original")).run.items.find(item => item.type === "approval");
  await assert.rejects(f.service.command("original", "approval", { requestId: "stale", itemId: approval.id, approved: true }), { code: "NATIVE_RUN_CHANGED" });
  await f.service.command("original", "approval", { requestId, itemId: approval.id, approved: true, optionId: "accept" });
  assert.deepEqual(f.calls.find(call => call.method === "response").response, { decision: "accept" });
  f.client.handleServerRequest({ id: 12, method: "item/tool/requestUserInput", params: {
    threadId: "original", turnId: "turn-1", questions: [{ id: "q", header: "", question: "Which?", isOther: true, isSecret: false, options: null }]
  } });
  const prompt = (await f.service.snapshot("original")).run.items.find(item => item.type === "userInput");
  await f.service.command("original", "input", { requestId, itemId: prompt.id, answers: { q: ["answer"] } });
  assert.deepEqual(f.calls.filter(call => call.method === "response").at(-1).response.answers.q.answers, ["answer"]);
  assert.equal((await f.service.command("original", "stop", { requestId })).run.state, "stopping");
  assert.deepEqual(f.calls.find(call => call.method === "turn/interrupt").params, { threadId: "original", turnId: "turn-1" });
  f.complete("interrupted");
  assert.equal((await f.service.snapshot("original")).run.state, "interrupted");
});

test("process loss is reconciled only by the matching native terminal turn", async t => {
  const f = await fixture(t);
  await f.service.send("original", { requestId: "request-0000000001", message: "Hello" });
  f.client.transport.initialized = false;
  assert.equal((await f.service.snapshot("original")).run.state, "unknown");
  f.source.activity = { state: "completed", turnId: "another-turn" };
  assert.equal((await f.service.snapshot("original")).run.state, "unknown");
  f.source.activity = { state: "completed", turnId: "turn-1" };
  const result = await f.service.snapshot("original");
  assert.equal(result.run.state, "completed");
  assert.equal(result.run.historyCursor, null);
});

test("archived continuation explicitly unarchives but never changes the default environment", async t => {
  const f = await fixture(t);
  f.source.session.archived = true;
  await f.service.send("original", { requestId: "request-0000000001", message: "Continue" });
  const methods = f.calls.map(call => call.method);
  assert.ok(methods.indexOf("thread/unarchive") < methods.indexOf("thread/resume"));
  assert.equal(methods.includes("config/value/write"), false);
});

test("completed live output switches to persisted history only after its terminal record is visible", async t => {
  const f = await fixture(t);
  await f.service.send("original", { requestId: "request-0000000001", message: "Continue" });
  f.client.handleNotification({ method: "turn/completed", params: { threadId: "original", turn: { id: "turn-1", status: "completed" } } });
  assert.equal((await f.service.snapshot("original")).run.historyCursor, "original-history-boundary");
  f.source.activity = { state: "completed", turnId: "turn-1" };
  assert.equal((await f.service.snapshot("original")).run.historyCursor, null);
});

test("program changes cannot close active native work and release idle clients after completion", async t => {
  const f = await fixture(t);
  await f.service.send("original", { requestId: "request-0000000001", message: "Continue" });
  await assert.rejects(f.service.releaseIdleClients(), { code: "NATIVE_SESSION_BUSY" });
  assert.equal(f.client.transport.initialized, true);
  f.complete();
  await f.service.releaseIdleClients();
  assert.equal(f.client.transport.initialized, false);
  assert.equal((await f.service.snapshot("original")).run.historyCursor, null);
  await f.service.withExecutableTransition(async () => {
    await assert.rejects(f.service.send("original", { requestId: "request-0000000002", message: "Wait" }), { code: "NATIVE_PROGRAM_CHANGING" });
  });
  assert.equal((await f.service.send("original", { requestId: "request-0000000002", message: "Continue" })).run.state, "running");
});
