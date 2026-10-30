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
import { Governor } from "./governor.mjs";
import { shouldReply, isSilent, CircuitBreaker } from "./reply-safety.mjs";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
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


const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
mkdirSync(ROOM_DIR, { recursive: true });

// Shared silence-biased policy (same Governor the residents use).
let POLICY = {};
try { POLICY = JSON.parse(readFileSync(path.join(HERE, "governor.json"), "utf8")); } catch { /* defaults */ }
const BOT_PEERS = ["umpire-bot", "gate-bot", "resident", "squire", "colt", "jeeves"];
const BOT_QUIET_START = env("BOT_QUIET_START", "") === "1";

let ws = null;
let seq = 0;
const pending = new Map();
const myMessageIds = new Set();
const gov = new Governor(POLICY, { self: SELF, bots: BOT_PEERS });
// Independent outbound-post breaker (applies to agent replies AND deterministic
// acks). State persists across restarts; a trip latches for BREAKER_RESET_MS.
const BREAKER_RESET_MS = Number(env("BREAKER_RESET_MS", String(30 * 60 * 1000)));
const breaker = new CircuitBreaker({ stateFile: path.join(HERE, "breaker-state.json"), resetMs: BREAKER_RESET_MS });
if (breaker.tripped) console.log(`bridge: circuit breaker latched at boot (until ${new Date(breaker.trippedAt + BREAKER_RESET_MS).toISOString()})`);
if (BOT_QUIET_START) {
  gov.quiet = true;
  gov.quietUntil = Infinity;
  console.log("governor: starting quiet (BOT_QUIET_START=1) — resume via chat");
}
let lastRoom = ROOMS[0];
let queue = Promise.resolve(); // serialize hermes runs
const recent = []; // last N room messages for context: {from, text}

function request(method, params) {
  return new Promise((resolve, reject) => {
    // Unique across process restarts: the server dedupes request ids globally,
    // so a plain per-boot counter collides with ids an earlier connection used.
    const id = `br-${process.pid.toString(36)}-${Date.now().toString(36)}-${++seq}`;
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

// Persona sessions grow a few hundred messages a day, and `--continue` on a
// bloated session spent minutes on prefill/compression until every reply hit
// the timeout and the bridge went silent. Bound the session's life: start a
// fresh one after BRIDGE_SESSION_MAX_HOURS. Room continuity is not lost — every
// prompt already carries a rolling 12-message window, and AGENTS.md is the
// persona.
const SESSION_MARKER = path.join(HERE, ".session-started");
const SESSION_MAX_MS = Number(env("BRIDGE_SESSION_MAX_HOURS", "24")) * 3600 * 1000;

function sessionIsFresh() {
  try { return Date.now() - Number(readFileSync(SESSION_MARKER, "utf8")) < SESSION_MAX_MS; }
  catch { return false; }
}

function askHermes(prompt) {
  return new Promise((resolve) => {
    const fresh = sessionIsFresh();
    const args = fresh ? ["-z", prompt, "--continue"] : ["-z", prompt];
    if (!fresh) {
      try { writeFileSync(SESSION_MARKER, String(Date.now())); } catch { /* marker is best-effort */ }
      console.log("bridge: starting a fresh persona session");
    }
    const child = spawn(HERMES_BIN, args, {
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
  // Every outbound path — model replies and deterministic acknowledgments —
  // goes through the breaker. No allow, no post.
  if (!breaker.allow()) {
    console.log(`bridge: breaker open, suppressed post to ${roomId}`);
    return;
  }
  const posted = await request("message", {
    room_id: roomId,
    ...(replyTo !== undefined ? { reply_to: { message_id: replyTo } } : {}),
    body: { text, format: "markdown" },
  });
  if (posted.message_id) myMessageIds.add(posted.message_id);
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

  const d = gov.classify({ from, text: m.text, replyTo: m.reply_to ?? null });
  if (d.action === "quiet") {
    console.log(`bridge: quiet until resumed (triggered by ${from})`);
    await postReply(m.room, m.message_id, `Going quiet. Say "${SELF} resume" to bring me back.`);
    return;
  }
  if (d.action === "resumed") {
    await postReply(m.room, m.message_id, "Back.");
    return;
  }
  if (d.action !== "reply") {
    console.log(`bridge: observed ${from} (no reply${d.reason ? `: ${d.reason}` : ""})`);
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
    `(You are in room id ${m.room ?? lastRoom} — needed for the spawn-task tool.)`,
    `Reply with only the message to post in the room — concise and casual, no preamble, no quotes around it. Plain text.`,
    `If no reply is actually warranted, reply with exactly [SILENT] (and nothing else) — the bridge will not post it, but the conversation stays in your memory.`,
  ].join("\n");

  console.log(`bridge: replying to ${from} (${m.message_id})`);
  // Fail-closed decision gate: only send to the agent when the sender is
  // explicitly asking us to respond. Bots chatting among themselves (ack
  // storms, cross-talk) never are. On gate failure we still keep the room
  // context — the message is already in `recent`.
  const gate = await shouldReply({ text: m.text, self: SELF, from, isBot: gov.bots.has(from) });
  if (!gate) {
    console.log(`bridge: decision gate declined reply to ${from} (${m.message_id})`);
    return;
  }
  queue = queue.then(async () => {
    const { text: out, error } = await askHermes(prompt);
    if (error || !out) {
      console.error(`bridge: hermes failed: ${error || "empty reply"}`);
      return;
    }
    if (isSilent(out)) {
      console.log(`bridge: hermes chose silence (${m.message_id})`);
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
