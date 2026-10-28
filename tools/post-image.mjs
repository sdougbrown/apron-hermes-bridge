// Post an image into an apron room as an upload embed (renders in the app).
// Usage: node post-image.mjs <room_id|"dm"> <image_path_or_url> [caption]
// "dm" resolves to (or creates) a private hermes↔doug room; the id is cached
// in ~/.local/state/apron-hermes-dm.
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const [,, roomArg, imageRef, caption = ""] = process.argv;
if (!roomArg || !imageRef) { console.error("usage: post-image.mjs <room_id|dm> <image_path_or_url> [caption]"); process.exit(1); }
const token = readFileSync(process.env.APRON_TOKEN_FILE || process.env.HOME + "/.secrets/apron-hermes.token", "utf8").trim();
const DM_CACHE = process.env.APRON_DM_CACHE || process.env.HOME + "/.local/state/apron-hermes-dm";

const ws = new WebSocket(process.env.APRON_URL || "ws://127.0.0.1:8070/ws");
const pre = "pi" + Date.now().toString(36);
let n = 0; const pending = new Map();
ws.on("message", (d) => { const f = JSON.parse(d); if (f.id && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); } });
const req = (method, params) => new Promise((res, rej) => {
  const id = `${pre}-${++n}`;
  pending.set(id, (f) => f.error ? rej(new Error(f.error.message)) : res(f.result));
  ws.send(JSON.stringify({ id, method, params }));
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });

async function ensureDmRoom() {
  try {
    const cached = readFileSync(DM_CACHE, "utf8").trim();
    if (cached) return cached;
  } catch { /* no cache */ }
  const joined = await req("room_list", { filter: "joined", members: true });
  for (const room of joined.joined || []) {
    if (room.private && (room.members || []).some((m) => m.user_id === "doug")) {
      writeFileSync(DM_CACHE, room.room_id + "\n");
      return room.room_id;
    }
  }
  const created = await req("room_set", { private: true, title: "hermes ↔ doug" });
  const roomId = created.room_id;
  await req("room_join", { room_id: roomId, user_id: "doug" });
  mkdirSync(path.dirname(DM_CACHE), { recursive: true });
  writeFileSync(DM_CACHE, roomId + "\n");
  return roomId;
}

ws.on("open", async () => {
  try {
    await req("auth", { scheme: "token", token, agent: "bridge/image" });
    const roomId = roomArg === "dm" ? await ensureDmRoom() : roomArg;

    // Load bytes: local path or URL.
    let bytes, mime;
    if (/^https?:\/\//.test(imageRef)) {
      const res = await fetch(imageRef);
      if (!res.ok) throw new Error(`fetch failed (${res.status})`);
      bytes = Buffer.from(await res.arrayBuffer());
    } else {
      bytes = readFileSync(imageRef);
    }
    const ext = path.extname(imageRef).toLowerCase();
    mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
    const title = caption || path.basename(imageRef) || "image";

    const posted = await req("message", {
      room_id: roomId,
      body: { text: caption, format: "plain", embeds: [{ kind: "upload", title }] },
    });
    const written = (posted.embeds || [])[0];
    if (!written || !written.write_url) throw new Error("no write_url in result: " + JSON.stringify(posted).slice(0, 200));
    const up = await fetch(written.write_url, { method: "PUT", body: bytes, headers: { "Content-Type": mime } });
    if (!up.ok) throw new Error(`upload failed (${up.status})`);
    console.log(`posted image to ${roomId} (message ${posted.message_id}, ${bytes.length} bytes)`);
  } catch (e) { console.error("post-image failed:", e.message); process.exitCode = 1; }
  ws.close(); process.exit(process.exitCode || 0);
});
