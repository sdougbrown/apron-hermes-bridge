// Read apron room history as the hermes persona.
// Usage: node history.mjs <room_id> [--limit N] [--before <log_id>] [--thread <message_id>] [--json]
//
// Plain output is one message per line: [log_id] name: text (with "↳ reply_to <id>"
// when threaded). --thread walks the reply chain of the given message instead of
// printing room scrollback: the chain plus its root message.
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const room = argv[0];
if (!room) { console.error("usage: history.mjs <room_id> [--limit N] [--before ID] [--thread ID] [--json]"); process.exit(1); }
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const limit = Number(flag("--limit") ?? (flag("--thread") ? 200 : 40));
const before = flag("--before");
const thread = flag("--thread");
const asJson = argv.includes("--json");

const token = readFileSync(process.env.APRON_TOKEN_FILE || process.env.HOME + "/.secrets/apron-hermes.token", "utf8").trim();
const ws = new WebSocket(process.env.APRON_URL || "ws://127.0.0.1:8070/ws");
let n = 0; const pending = new Map();
ws.on("message", (d) => { const f = JSON.parse(d); if (f.id && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); } });
const req = (method, params) => new Promise((res, rej) => {
  const id = "hist-" + Date.now().toString(36) + "-" + (++n);
  pending.set(id, (f) => f.error ? rej(new Error(f.error.message)) : res(f.result));
  ws.send(JSON.stringify({ id, method, params }));
});

function render(m) {
  const who = m.from?.name || m.from?.user_id || "?";
  const text = (m.body?.text ?? "").replace(/\s+/g, " ").trim();
  const reply = m.reply_to?.message_id ? ` ↳ reply_to ${m.reply_to.message_id}` : "";
  const extra = Object.keys(m)
    .filter((k) => !["body", "from", "log_id", "message_id", "reply_to", "room_id", "deleted"].includes(k))
    .map((k) => `${k}=${JSON.stringify(m[k]).slice(0, 200)}`);
  return `[${m.log_id}] ${who}:${reply} ${text}${extra.length ? "  (" + extra.join(" ") + ")" : ""}`;
}

ws.on("open", async () => {
  try {
    await req("auth", { scheme: "token", token, agent: "bridge/history" });
    let page = await req("history", { room_id: room, limit, ...(before ? { before } : {}) });
    let messages = page.messages ?? [];

    if (thread) {
      // Follow reply_to upward until we hit a message not in the page (older
      // than the window) — fetch one more page in that case, then stop.
      const byId = new Map(messages.map((m) => [m.message_id, m]));
      let cur = byId.get(thread) ?? null;
      if (!cur) {
        for (let hops = 0; hops < 5 && !cur; hops += 1) {
          const oldest = messages[0]?.log_id;
          if (!oldest || !page.more) break;
          page = await req("history", { room_id: room, limit: 200, before: oldest });
          messages = [...(page.messages ?? []), ...messages];
          messages.forEach((m) => byId.set(m.message_id, m));
          cur = byId.get(thread) ?? null;
        }
      }
      const chain = [];
      const seen = new Set();
      while (cur && !seen.has(cur.message_id)) {
        seen.add(cur.message_id);
        chain.unshift(cur);
        const parentId = cur.reply_to?.message_id;
        cur = parentId ? byId.get(parentId) ?? null : null;
      }
      messages = chain;
    }

    if (asJson) { console.log(JSON.stringify(messages, null, 2)); }
    else { for (const m of messages) console.log(render(m)); }
  } catch (e) { console.error("history failed:", e.message); process.exitCode = 1; }
  ws.close(); process.exit(process.exitCode || 0);
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
