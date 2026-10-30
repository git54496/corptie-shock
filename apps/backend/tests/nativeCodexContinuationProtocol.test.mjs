import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeCodexContinuation } from "../src/application/nativeCodexContinuation.mjs";
import { NativeCodexSessionReader } from "../src/application/nativeCodexSessionReader.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";
import { resolveCodexCommand } from "../src/utils/codexCommand.mjs";

// 真实 Codex 协议进程 + 本机模拟模型：独立 Home，无用户凭据、无公网调用。
test("real Codex resumes a persisted native thread with its previous conversation intact", {
  skip: process.env.CORPTIE_CODEX_PROTOCOL_TEST !== "1", timeout: 60_000
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "corptie-native-protocol-"));
  const home = join(root, "codex");
  const workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace);
  const bodies = [];
  let serverError;
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.url, "/v1/responses");
      assert.equal(req.headers.authorization, undefined);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      const text = bodies.length === 1 ? "SEED_REPLY" : "CONTINUED_REPLY";
      const id = `msg_${bodies.length}`;
      const item = { id, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text, annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    })().catch(cause => { serverError = cause; res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeFile(join(home, "config.toml"), `model = "gpt-5.4"\nmodel_provider = "offline_native"\n[model_providers.offline_native]\nname = "Offline native test"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  const children = [];
  const runtimeOptions = () => ({
    command: "/usr/bin/sandbox-exec",
    args: ["-p", '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))',
      resolveCodexCommand(), "app-server", "--listen", "stdio://"],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, CODEX_HOME: home, RUST_LOG: "error" },
    spawnProcess: (command, args, options) => { const child = spawn(command, args, { ...options, cwd: workspace }); children.push(child); return child; }
  });
  const seed = new CodexAppServerClient(runtimeOptions());
  const service = new NativeCodexContinuation({ home: () => home, journalPath: () => join(root, "journal.json"), runtimeOptions });
  t.after(async () => {
    await seed.close(); await service.close();
    await Promise.all(children.map(child => child.exitCode != null || child.signalCode != null ? null
      : new Promise(resolve => { child.once("exit", resolve); child.kill("SIGTERM"); })));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const thread = await seed.startThread({ cwd: workspace, model: "gpt-5.4", sandbox: "read-only", approvalPolicy: "on-request" });
  const threadId = thread.thread.id;
  await seed.startTurn(threadId, "SEED_USER_MESSAGE");
  const reader = new NativeCodexSessionReader({ home: () => home });
  await until(async () => (await reader.continuationSnapshot(threadId)).activity.state === "completed");
  await seed.close();
  const accepted = await service.send(threadId, { requestId: "protocol-request-000001", message: "CONTINUATION_USER_MESSAGE" });
  assert.notEqual(accepted.run.state, "failed", accepted.run.error);
  assert.notEqual(accepted.run.state, "unknown", accepted.run.error);
  await until(async () => (await service.snapshot(threadId)).run.state === "completed");
  await until(async () => (await reader.history(threadId)).items.some(item => item.text === "CONTINUED_REPLY"));
  if (serverError) throw serverError;
  assert.equal(bodies.length, 2);
  const history = JSON.stringify(bodies[1].input);
  assert.match(history, /SEED_USER_MESSAGE/);
  assert.match(history, /SEED_REPLY/);
  assert.match(history, /CONTINUATION_USER_MESSAGE/);
  assert.equal((await reader.list()).sessions.length, 1);
  assert.equal((await reader.list()).sessions[0].id, threadId);
  await service.send(threadId, { requestId: "protocol-request-000001", message: "CONTINUATION_USER_MESSAGE" });
  assert.equal(bodies.length, 2);
  await service.send(threadId, { requestId: "protocol-request-000002", message: "SECOND_CONTINUATION" });
  await until(async () => (await service.snapshot(threadId)).run.state === "completed");
  assert.equal(bodies.length, 3);
  assert.match(JSON.stringify(bodies[2].input), /CONTINUED_REPLY/);
  assert.match(JSON.stringify(bodies[2].input), /SECOND_CONTINUATION/);
  assert.equal((await reader.list()).sessions.length, 1);
});

async function until(predicate) {
  for (let i = 0; i < 100; i++) { try { if (await predicate()) return; } catch {} await delay(100); }
  throw new Error("Native protocol did not reach the expected state in time");
}
