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
- `hermes-apron.service` (systemd user unit, installed separately) runs the
  bridge: `systemctl --user status hermes-apron`.

Protocol notes: `message` with `message_id` + `deleted: true` tombstones a
message; history comes back as `{messages: [...]}` with `from.user_id`,
`body.text`, `reply_to.message_id`.
