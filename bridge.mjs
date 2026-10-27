// Hermes ↔ apron bridge. Connects to aprond as the "hermes" persona and
// answers messages that address it; everything else is logged as room
// context. Each reply is produced by `hermes -z` running in ./room, which
// keeps one persistent session there (--continue), so the persona remembers
// prior turns across messages.
//
// Env:
//   APRON_URL          ws://127.0.0.1:8070/ws
//   APRON_ROOMS        comma list (default: general + the resident room)
//   APRON_TOKEN_FILE   default ~/.secrets/apron-hermes.token
//   HERMES_BIN         default hermes
//   BRIDGE_TIMEOUT_S   per-reply timeout, default 240
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const env = (name, fallback) => process.env[name] ?? fallback;
const URL_ = env("APRON_URL", "ws://127.0.0.1:8070/ws");
const ROOMS = env("APRON_ROOMS", "general,1793043412152").split(",").map((x) => x.trim()).filter(Boolean);
const TOKEN_FILE = env("APRON_TOKEN_FILE", path.join(process.env.HOME, ".secrets/apron-hermes.token"));
const SELF = env("BOT_USER_ID", "hermes");
const HERMES_BIN = env("HERMES_BIN", "hermes");
const TIMEOUT_MS = Number(env("BRIDGE_TIMEOUT_S", "240")) * 1000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOM_DIR = path.join(HERE, "room");
const MAX_REPLIES_PER_HOUR = 12;
const QUIET_WORDS = ["quiet", "shush", "stop"];
const RESUME_WORDS = ["resume"];

const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
mkdirSync(ROOM_DIR, { recursive: true });

let ws = null;
let seq = 0;
const pending = new Map();
const myMessageIds = new Set();
const replyTimes = [];
let lastRoom = ROOMS[0];
let quiet = false;
let queue = Promise.resolve(); // serialize hermes runs
const recent = []; // last N room messages for context: {from, text}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = `br-${++seq}`;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(method + ": timed out")); }, 15000);
  });
}

const TRIGGER = new RegExp(`\\b${SELF}\\b`, "i");

function isAddressed(m) {
  const text = m.text.toLowerCase();
  const atMention = text.includes(`@${SELF}`);
  const startsAddress = [`${SELF}:`, `${SELF},`].some((p) => text.startsWith(p));
  const threadReply = m.reply_to !== undefined && myMessageIds.has(m.reply_to);
  return atMention || startsAddress || threadReply || TRIGGER.test(m.text);
}

function askHermes(prompt) {
  return new Promise((resolve) => {
    const child = spawn(HERMES_BIN, ["-z", prompt, "--continue"], {
      cwd: ROOM_DIR, env: process.env,
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ text: null, error: "timed out" }); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", () => { clearTimeout(timer); resolve({ text: out.trim(), error: null }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ text: null, error: e.message }); });
  });
}

async function postReply(roomId, replyTo, text) {
  const posted = await request("message", {
    room_id: roomId,
    ...(replyTo !== undefined ? { reply_to: { message_id: replyTo } } : {}),
    body: { text, format: "plain" },
  });
  if (posted.message_id) myMessageIds.add(posted.message_id);
  replyTimes.push(Date.now());
}

async function handle(m) {
  const from = m.from;
  if (m.room) lastRoom = m.room;
  // Room-context window includes my own replies, so the next turn can see them.
  if (from && m.text) {
    recent.push({ from: from || SELF, text: m.text });
    if (recent.length > 12) recent.shift();
  }
  if (!from || from === SELF) return;

  const text = m.text.toLowerCase();
  // Ack only on the false→true transition: the ack text itself contains a
  // quiet word and our name, so re-acking every match echo-loops forever.
  if (QUIET_WORDS.some((w) => text.includes(w)) && isAddressed(m)) {
    if (quiet) return;
    quiet = true;
    console.log(`bridge: quiet until resumed (triggered by ${from})`);
    await postReply(m.room, m.message_id, `Going quiet. Say "${SELF} resume" to bring me back.`);
    return;
  }
  if (quiet) {
    if (RESUME_WORDS.some((w) => text.includes(w)) && isAddressed(m)) {
      quiet = false;
      await postReply(m.room, m.message_id, "Back.");
    }
    return;
  }

  if (!isAddressed(m)) {
    console.log(`bridge: observed ${from} (no reply)`);
    return;
  }

  const now = Date.now();
  while (replyTimes.length && now - replyTimes[0] > 60 * 60 * 1000) replyTimes.shift();
  if (replyTimes.length >= MAX_REPLIES_PER_HOUR) {
    console.log(`bridge: cooldown cap for ${from}`);
    return;
  }

  const context = recent
    .slice(-10)
    .map((r) => `${r.from}: ${r.text}`)
    .join("\n");
  const prompt = [
    `You are Hermes, chatting in an apron chat room on Doug's homelab.`,
    `Recent room traffic (oldest first):`,
    context,
    ``,
    `${from} has addressed you and is waiting for a reply: "${m.text}"`,
    `Reply with only the message to post in the room — concise and casual, no preamble, no quotes around it. Plain text.`,
  ].join("\n");

  console.log(`bridge: replying to ${from} (${m.message_id})`);
  queue = queue.then(async () => {
    const { text: out, error } = await askHermes(prompt);
    if (error || !out) {
      console.error(`bridge: hermes failed: ${error || "empty reply"}`);
      return;
    }
    try { await postReply(m.room ?? lastRoom, m.message_id, out); }
    catch (e) { console.error(`bridge: post failed: ${e.message}`); }
  });
}

function connect() {
  ws = new WebSocket(URL_);
  ws.on("open", async () => {
    try {
      await request("auth", { scheme: "token", token: TOKEN, agent: "bridge/0" });
      for (const room of ROOMS) await request("room_join", { room_id: room });
      for (const room of ROOMS) {
        const h = await request("history", { room_id: room, limit: 200 });
        for (const msg of (h && h.messages) || []) {
          if (msg.deleted) continue;
          if (msg.from && msg.from.user_id === SELF && msg.message_id) myMessageIds.add(msg.message_id);
        }
      }
      console.log(`bridge up; rooms ${ROOMS.join(", ")} (${myMessageIds.size} of our messages known)`);
    } catch (e) {
      console.error("setup failed:", e.message);
      ws.close();
    }
  });
  ws.on("message", (d) => {
    let f;
    try { f = JSON.parse(d); } catch { return; }
    if (f.id && pending.has(f.id)) {
      const p = pending.get(f.id); pending.delete(f.id);
      f.error ? p.reject(new Error(f.error.message)) : p.resolve(f.result);
      return;
    }
    if (f.method === "message" && f.params) {
      const m = f.params.message || f.params;
      if (!m.message_id) return;
      handle({
        from: m.from && m.from.user_id,
        reply_to: m.reply_to && m.reply_to.message_id,
        text: (m.body && m.body.text) || "",
        message_id: m.message_id,
        room: m.room_id,
      }).catch((e) => console.error("handle message:", e.message));
    }
  });
  ws.on("error", () => {});
  ws.on("close", () => setTimeout(connect, 1000));
}
connect();
