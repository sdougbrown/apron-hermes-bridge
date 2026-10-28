// Mint a jeeves (family) identity on aprond via the email-code ceremony.
// Token goes to /srv/data/bots/family/home/apron-jeeves.token (inside the
// family sandbox, not ~/.secrets).
const WebSocket = require("ws");
const fs = require("fs");
const SINK = process.env.HOME + "/.local/state/apron-mail-router/mail.eml";
const URL = process.env.APRON_URL || "ws://127.0.0.1:8070/ws";
const EMAIL = "jeeves@apron.local";
const ws = new WebSocket(URL);
let n = 0; const pending = new Map();
ws.on("message", (d) => { const f = JSON.parse(d); if (f.id && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); } });
const req = (method, params) => new Promise((res, rej) => {
  const id = "enroll-" + (++n); pending.set(id, (f) => f.error ? rej(new Error(f.error.message)) : res(f.result));
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ws.on("open", async () => {
  try {
    const sinkBefore = fs.existsSync(SINK) ? fs.statSync(SINK).size : 0;
    await req("auth", { scheme: "email", email: EMAIL, user_id: "jeeves", name: "Jeeves", state: "" });
    let code = null;
    for (let i = 0; i < 40 && !code; i++) {
      await sleep(250);
      try {
        const size = fs.statSync(SINK).size;
        const buf = Buffer.alloc(size - sinkBefore);
        const fd = fs.openSync(SINK, "r");
        fs.readSync(fd, buf, 0, buf.length, sinkBefore);
        fs.closeSync(fd);
        const m = buf.toString().match(/Subject: .*?(\d{6,8})/);
        if (m) code = m[1];
      } catch (e) { /* sink not written yet */ }
    }
    if (!code) throw new Error("no code appeared in the mail sink");
    const result = await req("auth", { scheme: "email", token: code });
    if (!result.token) throw new Error("auth result carried no token: " + JSON.stringify(result).slice(0, 200));
    fs.writeFileSync("/srv/data/bots/family/home/apron-jeeves.token", result.token + "\n", { mode: 0o600 });
    console.log("jeeves enrolled; token saved");
    ws.close(); process.exit(0);
  } catch (e) { console.error("enroll failed:", e.message); ws.close(); process.exit(1); }
});
