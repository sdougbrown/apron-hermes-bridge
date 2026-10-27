// Run one task: hermes -z <prompt> in its own dir/session, then post the
// result (or failure) into the given apron room. Launched detached by
// spawn-task.mjs; writes <dir>/running with our pid while alive.
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [,, dir, room] = process.argv;
const TIMEOUT_MS = 30 * 60 * 1000;
const MAX_POST = 3800; // stay friendly to a chat room

writeFileSync(path.join(dir, "running"), String(process.pid));
process.on("exit", () => { try { rmSync(path.join(dir, "running")); } catch {} });

function post(text) {
  const child = spawn(process.execPath, [path.join(HERE, "post.mjs"), room, text], { stdio: "ignore" });
  child.on("error", (e) => console.error(`post failed: ${e.message}`));
}

try {
  writeFileSync(path.join(dir, "AGENTS.md"),
    "You are Hermes, running a task for Doug's apron chat room. Your final output is posted to the room verbatim: make it a self-contained, concise answer (a few sentences unless detail is genuinely needed). Use your tools for real work; don't narrate process.\n");

  const prompt = readFileSync(path.join(dir, "prompt.txt"), "utf8");
  const out = await new Promise((resolve) => {
    const child = spawn("hermes", ["-z", prompt, "--continue"], { cwd: dir, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => { clearTimeout(timer); resolve({ out: out.trim(), code }); });
    child.on("error", (e) => resolve({ out: "", code: -1, spawnError: e.message }));
  });

  if (out.spawnError) post(`task failed: could not start hermes (${out.spawnError})`);
  else if (out.out) post(out.out.length > MAX_POST ? out.out.slice(0, MAX_POST) + "\n…(truncated)" : out.out);
  else post(`task finished with no output (exit ${out.code}).`);
} catch (e) {
  post(`task failed: ${e.message}`);
}
