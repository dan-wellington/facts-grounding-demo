// Step 2 — atomic claim extraction. One Sonnet call (temp 0); one retry on
// JSON parse failure. Returns { sentences[], claims[{id, sentence_idx, text}] }.

const { callClaude } = require('./anthropicClient');

const SYSTEM = `You decompose a model's response into atomic factual claims so a downstream verifier can check each one against a context document. You produce strict JSON only — no commentary, no markdown.`;

const userPrompt = response => `Decompose the response below into:

1. Numbered sentences. Split on sentence boundaries; preserve original wording verbatim. Index from 0.

2. Atomic claims — each a single self-contained verifiable ASSERTION about reality.
   Treat the response as a sequence of factual commitments to be checked against a context document downstream.

   ─── EXTRACT (these are factual assertions, even if phrased as advice) ───
     • Comparative judgments — "X is better/stronger/more durable than Y"
     • Recommendations / preference assertions — "X is the better choice for Z",
       "X would be superior for Z", "X is preferred for Z"
     • Suitability / capability claims — "X is suitable for Z", "X can withstand Z",
       "X would not hinder Z", "X enables Y"
     • Causal claims — "X causes Y", "Because of X, Y happens"
     • Categorical/identity claims — "X is a type of Y", "X belongs to category Z"
     • Quantitative or descriptive properties — "X is light", "X has a woven pattern"

   ─── DO NOT EXTRACT (pure conversational scaffolding only) ───
     • Greetings / sign-offs — "Hello!", "Sure!", "I hope this helps", "Let me know if…"
     • Self-referential hedges — "I think", "In my opinion", "It seems likely"
     • Pure framing / structural transitions — "Here's a comparison:", "To summarize:",
       "First, let me explain…"
     • Questions directed at the reader

   When in doubt, EXTRACT. The downstream gate decides whether the document
   supports the claim. Recommendations and comparative judgments ARE claims —
   they assert facts about real-world preferences/applications.

3. Per-claim requirements:
   - Resolve all pronouns ("it", "they", "this") using context from the response so each claim stands alone.
   - One claim = one assertion. Split compound sentences into multiple claims.
   - Each claim must include "sentence_idx" pointing to the sentence it came from.
   - Number claims sequentially starting at 1.

Output ONLY valid JSON, no prose, no markdown fence:
{
  "sentences": ["sentence 0 verbatim", "sentence 1 verbatim", ...],
  "claims": [
    {"id": 1, "sentence_idx": 0, "text": "Self-contained atomic claim with pronouns resolved."},
    ...
  ]
}

Response to decompose:
"""
${response}
"""`;

function parseJson(s) {
  const trimmed = (s || '').trim();
  // Strip a single ```json …``` fence if the model added one.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function extractClaims({ response, model = process.env.EXTRACTOR_MODEL || 'claude-sonnet-4-6', onLog }) {
  // Three-tier attempt strategy:
  //   try1: standard prompt, max_tokens 4096
  //   try2: same as try1 (one plain retry — covers transient token glitches)
  //   try3: REPAIR PASS — max_tokens 8192 (some failures were truncation),
  //         and an emphatic "your previous output was malformed" instruction
  //         appended to the user prompt. We also pass the prior failed text
  //         so the model can see what to fix.
  const REPAIR_INSTRUCTION = badRaw =>
`\n\n────────────────────\nIMPORTANT — REPAIR REQUEST: a previous attempt produced output that JSON.parse() rejected. Your output MUST be a single complete JSON object, no markdown fences, no commentary, no truncation. The schema is exactly:
{
  "sentences": [...],
  "claims": [{"id": <int>, "sentence_idx": <int>, "text": <string>}, ...]
}
Previous (failed) output, for reference — DO NOT echo it; produce a corrected version:
"""
${(badRaw || '').slice(0, 1500)}
"""`;

  const attempt = async (tag, max_tokens, extraInstruction = '') => {
    onLog?.(`extractor ${tag} → ${model} (max_tokens=${max_tokens})`);
    const r = await callClaude({
      model,
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt(response) + extraInstruction }],
      max_tokens,
    });
    onLog?.(`extractor ${tag} ← raw (${r.text.length} chars)`);
    return r;
  };

  let raw, parsed, e1, e2;
  try {
    raw = await attempt('try1', 4096);
    parsed = parseJson(raw.text);
  } catch (err1) {
    e1 = err1;
    onLog?.(`extractor try1 parse failed: ${err1.message} — retrying`);
    try {
      raw = await attempt('try2', 4096);
      parsed = parseJson(raw.text);
    } catch (err2) {
      e2 = err2;
      onLog?.(`extractor try2 parse failed: ${err2.message} — REPAIR PASS`);
      try {
        raw = await attempt('try3-repair', 8192, REPAIR_INSTRUCTION(raw?.text || ''));
        parsed = parseJson(raw.text);
      } catch (err3) {
        throw new Error(`extractor JSON parse failed three times: ${err3.message} | try1: ${e1.message} | try2: ${e2.message} | last raw (${raw?.text?.length ?? 0} chars): ${(raw?.text ?? '').slice(0, 200)}`);
      }
    }
  }

  if (!Array.isArray(parsed.sentences) || !Array.isArray(parsed.claims))
    throw new Error('extractor JSON missing sentences[] / claims[]');

  // Defensive: clamp claim sentence_idx to valid range, force numeric ids.
  parsed.claims = parsed.claims.map((c, i) => ({
    id: Number.isInteger(c.id) ? c.id : i + 1,
    sentence_idx: Math.max(0, Math.min(parsed.sentences.length - 1, parseInt(c.sentence_idx, 10) || 0)),
    text: String(c.text || '').trim(),
  })).filter(c => c.text);

  return { sentences: parsed.sentences.map(String), claims: parsed.claims, raw_text: raw.text };
}

module.exports = { extractClaims, parseJson };
