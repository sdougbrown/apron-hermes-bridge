// Fork a detached hermes worker for a long-running task.
// Usage: node spawn-task.mjs <room_id> <prompt...>
// The worker (runner.mjs) runs `hermes -z --continue` in its own task dir
// (own session) and posts the result into the room when done. Never blocks
// the caller — print confirmation and exit.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [,, room, ...rest] = process.argv;
const prompt = rest.join(" ");

if (!room || !prompt) {
  console.log("usage: spawn-task.mjs <room_id> <prompt>");
  process.exit(1);
}

// Cap concurrent workers: count dirs with a live lock file.
let running = 0;
try {
  const tasksDir = path.join(HERE, "..", "tasks");
  for (const d of readdirSync(tasksDir)) {
    try {
      const pid = Number(readFileSync(path.join(tasksDir, d, "running"), "utf8").trim());
      process.kill(pid, 0);
      running++;
    } catch { /* not running */ }
  }
} catch { /* no tasks dir yet */ }
if (running >= 3) {
  console.log("error: 3 tasks already running — wait for one to finish");
  process.exit(1);
}

const id = Date.now().toString(36);
const dir = path.join(HERE, "..", "tasks", id);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "prompt.txt"), prompt);

const child = spawn(process.execPath, [path.join(HERE, "runner.mjs"), dir, room], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
child.unref();
console.log(`task ${id} started (pid ${child.pid}); it will post its result to the room itself when done.`);
