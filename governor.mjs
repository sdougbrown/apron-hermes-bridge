// Governor — structure-only wake policy for chat residents.
// Extracted from apron-resident/bot.mjs so other bots (hermes, …) reuse it.
// The policy is data (governor.json shape below); the governor holds the
// mutable state (quiet, cooldown window) and classifies each incoming
// message.
//
// STRUCTURE WAKES, THE JUDGE DECIDES THE REST. A message wakes the bot only
// through a hard signal — direct address prefix, @-mention, name mention
// (deliberate: the room router depends on name-anywhere), a reply to the
// bot's own message, or a DM. Whether unaddressed room chatter is "for" the
// bot is intent, and intent is judged by the room router's model decision —
// never by windows, heat, or reply-shape heuristics here. Silence is the
// default; the only gates kept are storm valves (hourly cap, min spacing).
//
//   const gov = new Governor(policy, { self: "resident", bots: ["squire", "gate-bot", "umpire-bot"] });
//   const d = gov.classify({ from: "doug", text: "resident: hi", replyTo: null, replyToMine: false, dm: false });
//   // d = { action: "reply" | "observe", reason?: "cooldown cap" | "min spacing" | "quiet" | "bot traffic" }
//
// Policy shape (all keys optional):
// {
//   triggers: { addressPrefixes: ["resident:", "resident,"], nameAnywhere: true },
//   quietWords: ["quiet", "shush", "stop"],
//   resumeWords: ["resume"],
//   cooldown: { maxRepliesPerHour: 12, minSecondsBetweenReplies: 0 }
// }

export class Governor {
  constructor(policy = {}, { self, bots = [], quietHours = 8 } = {}) {
    this.policy = policy;
    this.self = self;
    this.bots = new Set([self, ...bots]);
    this.quietHours = quietHours;
    this.replyTimes = [];
    this.lastBotMessageAt = 0;
    this.quiet = false;
    this.trigger = new RegExp(`\\b${self}\\b`, "i");
  }

  /** Classify one message. The caller performs the action (observe = durable
   * context write; reply = generate and post; quietAck/resumed = ack post).
   * `replyToMine` says whether `replyTo` targets one of OUR messages (the
   * caller resolves authorship from room history — never guess it here).
   * `dm` marks a private two-person room: any human message there is by
   * definition addressed — no name or thread required. */
  classify({ from, text, replyTo, replyToMine = false, dm = false }) {
    const isBot = this.bots.has(from);
    const lower = (text || "").toLowerCase();
    const atMention = lower.includes(`@${this.self}`);
    const startsAddress = (this.policy.triggers?.addressPrefixes || [`${this.self}:`, `${this.self},`])
      .some((p) => lower.startsWith(p));
    const nameMention = (this.policy.triggers?.nameAnywhere ?? true) && this.trigger.test(text);
    // In a multi-bot room a reply to another resident's message is theirs.
    const isThread = replyTo !== undefined && replyTo !== null && replyToMine === true;
    const dmAddressed = dm && !isBot;
    const isAddressed = startsAddress || atMention || isThread || dmAddressed;

    // Quiet/resume are explicit control words, honored from humans only.
    const quietWord = (this.policy.quietWords || []).find((w) => lower.includes(w));
    if (!isBot && quietWord && (isAddressed || nameMention)) {
      if (this.quiet) return { action: "observe", reason: "quiet" };
      this.quiet = true;
      return { action: "quiet", word: quietWord };
    }
    if (this.quiet) {
      const resume = (this.policy.resumeWords || []).some((w) => lower.includes(w));
      if (!isBot && resume && (startsAddress || isThread || dmAddressed)) {
        this.quiet = false;
        return { action: "resumed" };
      }
      return { action: "observe", reason: "quiet" };
    }

    if (isBot && !isAddressed) return { action: "observe", reason: "bot traffic" };
    if (!isAddressed && !nameMention) return { action: "observe" };
    return this.#gate();
  }

  /** Storm valves only — no intent heuristics. */
  #gate() {
    const now = Date.now();
    while (this.replyTimes.length && now - this.replyTimes[0] > 60 * 60 * 1000) this.replyTimes.shift();
    if (this.replyTimes.length >= (this.policy.cooldown?.maxRepliesPerHour ?? 12)) {
      return { action: "observe", reason: "cooldown cap" };
    }
    if (now - this.lastBotMessageAt < (this.policy.cooldown?.minSecondsBetweenReplies ?? 0) * 1000) {
      return { action: "observe", reason: "min spacing" };
    }
    this.replyTimes.push(now);
    this.lastBotMessageAt = now;
    return { action: "reply" };
  }

  noteBotReply() {
    this.lastBotMessageAt = Date.now();
  }
}
