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
    this.quiet = false;
    this.quietUntil = Infinity;
    this.trigger = new RegExp(`\\b${self}\\b`, "i");
  }

  /** Classify one message. The caller performs the action (observe = durable
   * context write; reply = generate and post; quietAck/resumed = ack post). */
  classify({ from, text, replyTo }) {
    // Bot messages don't count as room heat: two residents exchanging replies
    // must not defer each other into silence.
    if (!this.bots.has(from)) this.lastHumanMessageAt = Date.now();
    const isThread = replyTo !== undefined && replyTo !== null && !this.bots.has(from);
    const lower = (text || "").toLowerCase();
    const atMention = lower.includes(`@${this.self}`);
    const startsAddress = (this.policy.triggers?.addressPrefixes || [`${this.self}:`, `${this.self},`])
      .some((p) => lower.startsWith(p));
    const nameMention = (this.policy.triggers?.nameAnywhere ?? true) && this.trigger.test(text);
    const isAddressed = startsAddress || isThread || atMention;

    const quietWord = (this.policy.quietWords || []).find((w) => lower.includes(w));
    if (!this.bots.has(from) && quietWord && (startsAddress || isThread || nameMention)) {
      if (this.quiet) return { action: "observe", reason: "quiet" };
      this.quiet = true;
      this.quietUntil = Date.now() + this.quietHours * 60 * 60 * 1000;
      return { action: "quiet", word: quietWord };
    }
    if (this.quiet) {
      const resume = (this.policy.resumeWords || []).some((w) => lower.includes(w));
      if (!this.bots.has(from) && resume && (startsAddress || isThread)) {
        this.quiet = false;
        this.quietUntil = Infinity;
        return { action: "resumed" };
      }
      return { action: "observe", reason: "quiet" };
    }

    if (!isAddressed && !nameMention) return { action: "observe" };

    // Gate 1: room heat — a casual name-mention right after human-to-human
    // traffic defers. Addressed messages (prefix/thread/@) always pass.
    const heatWindow = (this.policy.roomHeatSeconds ?? 120) * 1000;
    if (!isAddressed && Date.now() - this.lastHumanMessageAt < heatWindow) {
      return { action: "observe", reason: "room-heat" };
    }
    // Gate 2: cooldown — sliding hourly cap + minimum spacing.
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
