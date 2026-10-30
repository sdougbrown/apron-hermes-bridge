# apron-hermes-bridge

Bridge that gives the Hermes agent a live persona in Doug's apron chat server
(`apron.home.douggo.com`, server code in `~/Code/apron-server-go`).

- `enroll-hermes.cjs` — one-time: mints the `hermes` identity via the
  email-code ceremony (needs the mail-router running) and writes
  `~/.secrets/apron-hermes.token`.
- `bridge.mjs` — the daemon. Connects to `ws://127.0.0.1:8070/ws`, joins
  `general` + the resident room (`APRON_ROOMS`), and replies when a message
  addresses `hermes` (name anywhere, `@hermes`, `hermes:`/`hermes,` prefix, or
  a thread reply to one of its messages). Unaddressed traffic is kept as a
  rolling 12-message context window. Quiet words ("quiet/shush/stop") silence
  it until "resume". Replies are capped at 12/hour.
- Each reply runs `hermes -z <prompt> --continue` with cwd `./room`, so the
  persona keeps one persistent session there (AGENTS.md in that dir is its
  persona prompt). Runs are serialized.
- `tools/spawn-task.mjs <room_id> <prompt>` — forks a detached worker
  (`tools/runner.mjs`) that runs `hermes -z --continue` in its own dir under
  `tasks/` (own session, 30-min budget, max 3 concurrent) and posts the
  result into the room itself via `tools/post.mjs`. The room persona is
  taught to use this from `room/AGENTS.md` (§ Long-running tasks); the
  bridge includes the room id in the reply prompt so it can.
- `tools/post-image.mjs <room_id|dm> <image|url> [caption]` — upload-embed an
  image into a room; `dm` = private hermes↔doug room (id cached in
  `~/.local/state/apron-hermes-dm`). The standard way to deliver generated
  images (see the Image generation section in `room/AGENTS.md`).
- `tools/post.mjs` / `tools/post-image.mjs` honor `APRON_TOKEN_FILE` (and
  `APRON_DM_CACHE`) so other personas — e.g. jeeves, the sandboxed family
  agent — can reuse them with their own tokens.
- `tools/history.mjs <room_id> [--limit N] [--before ID] [--thread ID] [--json]`
  reads room scrollback or walks a reply chain. Each reply prompt also carries
  the trigger message's chain from `thread.mjs`, so a bare "look into this"
  replying to a day-old message arrives with its antecedent instead of
  context-free.
- `enroll-jeeves.cjs` — one-time enrollment for the family persona (token →
  `/srv/data/bots/family/home/apron-jeeves.token`).
- `hermes-apron.service` (systemd user unit, installed separately) runs the
  bridge: `systemctl --user status hermes-apron`.

Protocol notes: `message` with `message_id` + `deleted: true` tombstones a
message; history comes back as `{messages: [...]}` with `from.user_id`,
`body.text`, `reply_to.message_id`.

## Storm protections (see governor.mjs / reply-safety.mjs)

Multi-bot rooms can go sideways: a bot's quiet-ack contains another bot's
name, which triggers another ack, which… produced over a million posts here
once. Layers, in order:

1. **Governor** — bot-authored messages can't trigger quiet/resume; quiet is
   acked only on the false→true transition (already-quiet bots just observe).
2. **Decision gate** — bot senders are additionally vetted by a local
   yes/no model (`/v1/decisions`, fail-closed): is the sender explicitly
   asking *this* bot to respond? Humans skip this gate — it's name-centric
   and misreads pronoun replies ("why are you not talking to me"), and a
   human message can only ever produce one agent turn, never a loop.
3. **[SILENT]** — the agent may answer exactly `[SILENT]`; the bridge
   suppresses it but keeps the exchange in the session.
4. **Circuit breaker** — every outbound post (agent replies *and*
   deterministic acks) passes a 5-per-60s breaker that persists its state to
   disk, so a restart can't reset a latched breaker.

Tests: `npm test` (node:test; 10 tests cover the governor against ack
storms, gate thresholds/fail-closed behavior, silence token, breaker timing
and restart persistence).

## Session lifetime

Each reply runs `hermes -z --continue` scoped to `./room`. Persona sessions
grow ~a few hundred messages a day; `--continue` on a bloated one spends
minutes in prefill/compression and blows the reply timeout, which looks like
silence. So the bridge starts a fresh session every
`BRIDGE_SESSION_MAX_HOURS` (default 24; marker file `.session-started`).
Continuity survives: every prompt carries a rolling 12-message room window and
`room/AGENTS.md` is the persona. `BRIDGE_TIMEOUT_S` (default 240) bounds each
run.
