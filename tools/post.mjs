// Post one message to an apron room as the hermes persona.
// Usage: node post.mjs <room_id> <text> [reply_to_message_id]
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const [,, room, text, replyTo] = process.argv;
if (!room || text === undefined) { console.error("usage: post.mjs <room_id> <text>"); process.exit(1); }
const token = readFileSync(process.env.APRON_TOKEN_FILE || process.env.HOME + "/.secrets/apron-hermes.token", "utf8").trim();

const ws = new WebSocket(process.env.APRON_URL || "ws://127.0.0.1:8070/ws");
let n = 0; const pending = new Map();
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.id && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); }
});
const req = (method, params) => new Promise((res, rej) => {
  const id = "post-" + Date.now().toString(36) + "-" + (++n);
  pending.set(id, (f) => f.error ? rej(new Error(f.error.message)) : res(f.result));
  ws.send(JSON.stringify({ id, method, params }));
});
ws.on("open", async () => {
  try {
    await req("auth", { scheme: "token", token, agent: "bridge/task" });
    const r = await req("message", {
      room_id: room,
      ...(replyTo ? { reply_to: { message_id: replyTo } } : {}),
      body: { text, format: "plain" },
    });
    console.log("posted", r.message_id);
  } catch (e) { console.error("post failed:", e.message); process.exitCode = 1; }
  ws.close(); process.exit(process.exitCode || 0);
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
