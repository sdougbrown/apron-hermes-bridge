// Reply-chain reconstruction. The bridge hands the model the chain of messages
// leading to the one it must answer, so a bare "look into this" carries its
// antecedent instead of arriving context-free.
//
// The server's history method pages backwards (`before: <oldest log_id>`), so a
// chain older than the first page may be missing. walkChain reports whether it
// hit such a hole (`missing`) so the caller can fetch more history.

export function walkChain(messages, messageId, { maxHops = 50 } = {}) {
  const byId = new Map(messages.map((m) => [m.message_id, m]));
  let cur = byId.get(messageId);
  if (!cur) return { chain: [], missing: Boolean(messageId) };
  const chain = [];
  const seen = new Set();
  let missing = false;
  while (cur && !seen.has(cur.message_id) && chain.length < maxHops) {
    seen.add(cur.message_id);
    chain.unshift(cur);
    const parent = cur.reply_to?.message_id;
    if (!parent) break;
    cur = byId.get(parent);
    if (!cur) missing = true;
  }
  return { chain, missing };
}

/** One prompt line per message: "[log_id] name: text". */
export function renderChain(chain) {
  return chain
    .map((c) => `[${c.log_id}] ${c.from?.name || c.from?.user_id || "?"}: ${(c.body?.text ?? "").replace(/\s+/g, " ")}`)
    .join("\n");
}
