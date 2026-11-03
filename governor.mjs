// Governor — silence-biased reply policy for chat residents.
// Extracted from apron-resident/bot.mjs so other bots (hermes, …) reuse it.
// The policy is data (governor.json shape below); the governor holds the
// mutable state (quiet, cooldown window, heat timer) and classifies each
// incoming message.
//
//   const gov = new Governor(policy, { self: "resident", bots: ["squire", "gate-bot", "umpire-bot"] });
//   const d = gov.classify({ from: "doug", text: "resident: hi", replyTo: null });
//   // d = { action: "reply" | "observe", reason?: "room-heat" | "cooldown cap" | "min spacing" | "quiet" | "first run" }
//
// Policy shape (all keys optional; defaults shown in governor.json):
// {
//   triggers: { addressPrefixes: ["resident:", "resident,"], nameAnywhere: true,
//               threadRepliesAlways: true },
//   quietWords: ["quiet", "shush", "stop"],
//   resumeWords: ["resume"],
//   roomHeatSeconds: 120,
//   cooldown: { maxRepliesPerHour: 12, minSecondsBetweenReplies: 0 },
//   observeUnaddressed: true
// }

export class Governor {
  constructor(policy = {}, { self, bots = [], quietHours = 8 } = {}) {
    this.policy = policy;
    this.self = self;
    this.bots = new Set([self, ...bots]);
    this.quietHours = quietHours;
    this.replyTimes = [];
    this.lastHumanMessageAt = 0;
    this.lastBotMessageAt = 0;
    this.lastBotReplyAt = 0;
    this.quiet = false;
    this.quietUntil = Infinity;
    this.trigger = new RegExp(`\\b${self}\\b`, "i");
  }

  /** Classify one message. The caller performs the action (observe = durable
   * context write; reply = generate and post; quietAck/resumed = ack post).
   * `dm` marks a private two-person room: there, any human message is by
   * definition addressed to the bot — no name or thread required. */
  classify({ from, text, replyTo, dm = false }) {
    // Bot messages don't count as room heat: two residents exchanging replies
    // must not defer each other into silence.
    if (!this.bots.has(from)) this.lastHumanMessageAt = Date.now();
    const isThread = replyTo !== undefined && replyTo !== null && !this.bots.has(from);
    const dmAddressed = dm && !this.bots.has(from);
    const lower = (text || "").toLowerCase();
    const atMention = lower.includes(`@${this.self}`);
    const startsAddress = (this.policy.triggers?.addressPrefixes || [`${this.self}:`, `${this.self},`])
      .some((p) => lower.startsWith(p));
    const nameMention = (this.policy.triggers?.nameAnywhere ?? true) && this.trigger.test(text);
    const isAddressed = startsAddress || isThread || atMention || dmAddressed;

    const quietWord = (this.policy.quietWords || []).find((w) => lower.includes(w));
    if (!this.bots.has(from) && quietWord && (isAddressed || nameMention)) {
      if (this.quiet) return { action: "observe", reason: "quiet" };
      this.quiet = true;
      this.quietUntil = Date.now() + this.quietHours * 60 * 60 * 1000;
      return { action: "quiet", word: quietWord };
    }
    if (this.quiet) {
      const resume = (this.policy.resumeWords || []).some((w) => lower.includes(w));
      if (!this.bots.has(from) && resume && (startsAddress || isThread || dmAddressed)) {
        this.quiet = false;
        this.quietUntil = Infinity;
        return { action: "resumed" };
      }
      return { action: "observe", reason: "quiet" };
    }

    if (!isAddressed && !nameMention) {
      // Continuation: a human replying within a few minutes of the bot's last
      // reply is still in conversation with it, even without a name. Bots are
      // excluded — unaddressed bot chatter must stay silent (storm safety).
      if (!this.bots.has(from) && Date.now() - this.lastBotReplyAt < (this.policy.followupSeconds ?? 300) * 1000) {
        return this.#gate("followup");
      }
      return { action: "observe" };
    }
    return this.#gate(isAddressed ? "addressed" : "name-mention");
  }

  /** Heat + cooldown gates shared by addressed messages and followups. */
  #gate(reason) {
    // Gate 1: room heat — a casual name-mention right after human-to-human
    // traffic defers. Skipped when the bot itself is in an active exchange:
    // rapid back-and-forth with the bot is the point of a direct chat, and
    // the "human traffic" is just that conversation.
    const heatWindow = (this.policy.roomHeatSeconds ?? 120) * 1000;
    if (reason === "name-mention" &&
        Date.now() - this.lastHumanMessageAt < heatWindow &&
        Date.now() - this.lastBotReplyAt > heatWindow) {
      return { action: "observe", reason: "room-heat" };
    }
    // Gate 2: cooldown — sliding hourly cap + minimum spacing.
    const now2 = Date.now();
    while (this.replyTimes.length && now2 - this.replyTimes[0] > 60 * 60 * 1000) this.replyTimes.shift();
    if (this.replyTimes.length >= (this.policy.cooldown?.maxRepliesPerHour ?? 12)) {
      return { action: "observe", reason: "cooldown cap" };
    }
    if (now2 - this.lastBotMessageAt < (this.policy.cooldown?.minSecondsBetweenReplies ?? 0) * 1000) {
      return { action: "observe", reason: "min spacing" };
    }
    this.replyTimes.push(now2);
    this.lastBotReplyAt = now2;
    this.lastBotMessageAt = now2;
    return { action: "reply" };
  }

  noteBotReply() {
    this.lastBotMessageAt = Date.now();
  }
}
