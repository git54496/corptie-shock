import { DatabaseSync } from "node:sqlite";
import { open, realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value) {
  if (!value) return null;
  try {
    if (value.length > 2048) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!parsed || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch { throw fail(400, "INVALID_CODEX_CURSOR", "分页位置无效，请刷新会话。"); }
}
const digest = value => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith("..") && !isAbsolute(rel); };

// 只读浏览器独立于 Corptie 的受管会话，不注册 Provider、恢复 Thread 或写入原始历史。
export class NativeCodexSessionReader {
  constructor({ home }) {
    // 每次读取重新解析本机 Home，使用户切换环境后无需重启后端。
    this.home = home;
  }

  async withIndex(action) {
    const home = this.home();
    const path = join(home, "state_5.sqlite");
    try { await stat(path); }
    catch (error) {
      if (error.code === "ENOENT") return { home, available: false, sessions: [], nextCursor: null };
      throw error;
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000");
      const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map(row => row.name));
      if (!["id", "title", "cwd", "source", "created_at", "updated_at", "archived", "rollout_path"].every(key => columns.has(key))) {
        throw fail(422, "CODEX_INDEX_UNSUPPORTED", "本机 Codex 会话索引格式暂不支持。");
      }
      return action(db, home, columns);
    } finally { db.close(); }
  }

  async list({ search = "", archived = false, cursor = null, limit = 50 } = {}) {
    const query = search.trim().slice(0, 300);
    const count = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 50));
    return this.withIndex((db, home, columns) => {
      const scope = digest(JSON.stringify([home, query, archived]));
      const after = decode(cursor);
      if (after && (after.scope !== scope || !Number.isSafeInteger(after.updatedAt) || typeof after.id !== "string")) {
        throw fail(400, "INVALID_CODEX_CURSOR", "筛选条件已改变，请刷新会话。");
      }
      const where = ["archived = ?"];
      const args = [archived ? 1 : 0];
      if (query) {
        const fields = ["title", "cwd", ...(columns.has("name") ? ["name"] : [])];
        where.push(`(${fields.map(field => `${field} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
        const match = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
        args.push(...fields.map(() => match));
      }
      if (after) { where.push("(updated_at < ? OR (updated_at = ? AND id < ?))"); args.push(after.updatedAt, after.updatedAt, after.id); }
      const rows = db.prepare(`SELECT id, title, cwd, source, created_at, updated_at, archived FROM threads
        WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args, count + 1);
      const page = rows.slice(0, count);
      const last = page.at(-1);
      return { home, available: true, sessions: page.map(summary), nextCursor: rows.length > count
        ? encode({ scope, updatedAt: last.updated_at, id: last.id }) : null };
    });
  }

  async continuationSnapshot(id) {
    return this.history(id, { inspectActivity: true });
  }

  async history(id, { cursor = null, limit = 80, inspectActivity = false } = {}) {
    const indexed = await this.withIndex((db, home) => ({ home, row: db.prepare(
      "SELECT id, title, cwd, source, created_at, updated_at, archived, rollout_path FROM threads WHERE id = ?"
    ).get(id) }));
    if (!indexed.row) throw fail(404, "CODEX_SESSION_NOT_FOUND", "本机会话不存在，请刷新列表。");
    const { row, home } = indexed;
    let path;
    try { path = await realpath(row.rollout_path); }
    catch (error) {
      if (error.code === "ENOENT") throw fail(404, "CODEX_HISTORY_UNAVAILABLE", "此会话的本地历史文件不可用，可能已移动或尚未同步。");
      throw error;
    }
    const roots = await Promise.all(["sessions", "archived_sessions"].map(name => realpath(join(home, name)).catch(() => null)));
    if (!roots.some(root => root && inside(root, path))) {
      throw fail(403, "CODEX_HISTORY_OUTSIDE_HOME", "会话历史不在当前 Codex Home 中，无法读取。");
    }
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw fail(422, "CODEX_HISTORY_UNSUPPORTED", "会话历史不是普通文件。");
      const scope = digest(JSON.stringify([home, id, info.dev, info.ino]));
      if (inspectActivity) {
        const page = await readHistoryPage(file, info.size, 1, projectActivity);
        return { home, session: summary(row), historyCursor: encode({ scope, offset: info.size }),
          activity: page.items[0] ?? { state: "unknown", turnId: null } };
      }
      const before = decode(cursor);
      if (before && (before.scope !== scope || !Number.isSafeInteger(before.offset) || before.offset < 0 || before.offset > info.size)) {
        throw fail(409, "CODEX_HISTORY_CHANGED", "会话历史已改变，请刷新后重新读取。");
      }
      const page = await readHistoryPage(file, before?.offset ?? info.size, Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 80)));
      return { session: summary(row), items: page.items, skippedRecords: page.skippedRecords,
        nextCursor: page.offset > 0 ? encode({ scope, offset: page.offset }) : null };
    } finally { await file.close(); }
  }
}

function summary(row) {
  return { id: row.id, title: row.title, cwd: row.cwd, source: row.source,
    createdAt: row.created_at, updatedAt: row.updated_at, archived: Boolean(row.archived) };
}

// 从末尾按字节分页，游标指向完整记录边界；追加日志不会改变已返回记录的 ID。
async function readHistoryPage(file, end, limit, project = projectRecord) {
  const items = [];
  let skippedRecords = 0;
  let position = end;
  let pending = Buffer.alloc(0);
  let nextOffset = end;
  const chunkSize = 64 * 1024;
  const scanBudget = 16 * 1024 * 1024;
  let scanned = 0;
  while (position > 0 || pending.length) {
    if (position > 0) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      const { bytesRead } = await file.read(chunk, 0, size, position);
      if (bytesRead !== size) throw fail(409, "CODEX_HISTORY_CHANGED", "历史文件正在改变，请刷新重试。");
      pending = Buffer.concat([chunk, pending]);
      scanned += size;
    }
    while (pending.length) {
      const trailing = pending.at(-1) === 10;
      const searchEnd = pending.length - (trailing ? 2 : 1);
      const boundary = searchEnd < 0 ? -1 : pending.lastIndexOf(10, searchEnd);
      if (boundary < 0 && position > 0) break;
      const start = boundary + 1;
      const line = pending.subarray(start, trailing ? pending.length - 1 : pending.length).toString("utf8");
      const offset = position + start;
      pending = pending.subarray(0, start);
      nextOffset = offset;
      if (line.trim()) {
        try {
          const item = project(JSON.parse(line), offset);
          if (item) items.push(item);
        } catch { skippedRecords += 1; }
      }
      if (items.length >= limit || scanned >= scanBudget) return { items: items.reverse(), offset: nextOffset, skippedRecords };
    }
    if (pending.length > scanBudget) throw fail(422, "CODEX_RECORD_TOO_LARGE", "单条历史记录超过 16 MB，暂时无法展示。");
    if (position === 0) break;
  }
  return { items: items.reverse(), offset: 0, skippedRecords };
}

function projectActivity(record) {
  if (record.type !== "event_msg") return null;
  const payload = record.payload ?? {};
  const state = { task_started: "running", task_complete: "completed", turn_aborted: "interrupted" }[payload.type];
  if (!state) return null;
  return { state, turnId: payload.turn_id ?? payload.root_turn_id ?? null, timestamp: record.timestamp ?? null };
}

function projectRecord(record, offset) {
  // response_item 是消息与工具调用的原始记录；不重复呈现 event_msg 中的同一消息。
  if (record.type !== "response_item") return null;
  const item = record.payload;
  if (!item || typeof item !== "object") return null;
  const base = { id: String(offset), timestamp: typeof record.timestamp === "string" ? record.timestamp : null };
  if (item.type === "message" && ["user", "assistant"].includes(item.role)) {
    const text = (Array.isArray(item.content) ? item.content : []).map(part => {
      if (["input_text", "output_text", "text"].includes(part.type)) return typeof part.text === "string" ? part.text : "";
      if (["input_image", "image"].includes(part.type)) return "[图片]";
      if (["input_audio", "audio"].includes(part.type)) return "[音频]";
      return "";
    }).filter(Boolean).join("\n\n");
    return text ? { ...base, kind: item.role, label: item.role === "user" ? "用户" : "Codex", text } : null;
  }
  if (["function_call", "custom_tool_call", "local_shell_call"].includes(item.type)) {
    const value = item.type === "function_call" ? item.arguments : item.type === "custom_tool_call" ? item.input : item.action;
    return { ...base, kind: "tool", label: typeof item.name === "string" ? item.name : item.type,
      text: printable(value) };
  }
  if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
    return { ...base, kind: "tool", label: "工具结果", text: printable(item.output) };
  }
  return null;
}

function printable(value) { return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2); }
