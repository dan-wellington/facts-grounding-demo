// Step 3 — confidence gate per atomic claim. v5 = stage-toggling.
// One conversation thread per claim with the model under test.
//
// Stages (each emits JSON {confidence:0-100}). v6.4: reasoning field removed
// from the output schema — models think internally but report only the score.
// This was the dominant output-token cost (paragraph-per-call × 3 stages ×
// every claim) and is the main lever for keeping the gate cheap at scale.
//   c1 parametric — "true based only on general knowledge?" (no context)
//   c2 grounded   — "verify against this context document"  (context injected)
//   c3 confront   — "re-evaluate critically against literal-support bar"
//
// v5 allows toggling individual stages via gate_c1_enabled / gate_c2_enabled /
// gate_c3_enabled (booleans, default true). Only four configs are allowed:
//
//   TTT — c1 → c2 → c3   (full v4 behavior; flag uses c3)
//   TTF — c1 → c2        (no confront;     flag uses c2)
//   FTT — c2 → c3        (skip parametric; flag uses c3)
//   FTF — c2 only        (sole grounded check; flag uses c2)
//
// All others (anything with c2 disabled) are rejected at validation time.
//
// Flagging: `flagged = lastEnabledConfidence < threshold`, where lastEnabled
// is c3 if it ran else c2. (c2 always runs in any allowed config.)
//
// Claims run in parallel with a concurrency cap (default 5). Per-claim logs
// are buffered and emitted atomically so concurrent runs don't interleave.

const { callArchitectureModel } = require('./architectureClient');
const { extractJson }           = require('./jsonExtract');

// ── Stage prompts ───────────────────────────────────────────────────────────
// v6.4: prompts ask the model to think internally (silently) and emit ONLY
// the confidence score. No "reasoning" field, no preamble, no chain-of-thought
// in the output. This collapses each stage's output from ~200 tokens to ~10
// and is the primary cost lever for the gate at scale.
const SILENCE = `Think through your reasoning silently before answering. DO NOT output your reasoning, explanation, preamble, or any prose. Output ONLY the JSON object specified below — nothing else.`;

const C1 = claim => `Consider this factual claim:

"${claim}"

Based ONLY on your general world knowledge — do NOT use any external context — how confident are you that this claim is true?

${SILENCE}

JSON schema:
{"confidence": <integer 0-100, where 100 = certainly true, 0 = certainly false>}`;

// c2 has two variants:
//   - C2_AFTER_C1: continuation of a c1 thread (claim is in conversation already)
//   - C2_STANDALONE: c2 is the first user turn; claim is inlined here
const C2_BODY = `STRICT LITERAL SUPPORT TEST. The bar is whether the document EXPLICITLY states the claim — not whether the claim is plausible, reasonable, or follows from common sense or domain knowledge.

A claim is supported (high confidence) ONLY IF the document contains a specific passage that directly states the claim or a near-paraphrase with the same factual content.

A claim is NOT supported (low confidence) if any of the following apply:
  • the document never mentions the subject of the claim
  • the document mentions the subject but doesn't make the specific assertion
  • the claim follows from a "reasonable inference", "logical extension", or "implication" of what the document says, but is not literally stated
  • the claim relies on outside or domain knowledge to bridge a gap from the document
  • the claim adds qualifiers, contexts, or applications (e.g. sports, performance, conditions) that the document doesn't itself raise

Confidence 0-100:
  100 = document literally states the claim (or unambiguous near-paraphrase).
   90 = literal support except for one minor detail that must be paraphrased.
   60 = strongly implied but not literally stated.
   30 = plausible inference; the document does not say this.
    0 = the document contradicts the claim or never mentions the topic.

If you would describe the support as "implied" or "follows from" — score under 60.

EXCEPTION — VERIFIABLE AGGREGATIONS: If the claim is a simple count, sum, ranking, set-difference, or max/min over items the document LITERALLY and unambiguously enumerates, score 90+ even though the aggregated value is not literally stated. The aggregation must be deterministic: you must be able to compute it with certainty by inspecting the literal items. Examples that PASS:
  • Document lists Authentic, Honey Lemon Ginseng, Goji Berry Pomegranate as flavors. Claim: "2 additional flavors excluding Authentic" → 95 (set-difference count over a literal enumeration).
  • Document states "Q1: $5M, Q2: $7M, Q3: $3M". Claim: "Q3 was the lowest quarter" → 95 (deterministic ranking of literal numeric values).
  • Document lists 4 named officers. Claim: "the document lists 4 officers" → 100 (literal count).

The exception does NOT apply, and you must still flag, when:
  • The document uses open-ended phrasing ("such as ...", "and others", "etc.", "including but not limited to") — counts are unbounded.
  • The document uses qualitative quantifiers ("many", "several", "a few", "most") — a specific number requires interpretation.
  • The aggregation crosses categories the document does not aggregate together.
  • The claim's qualifier or scope refers to a category the document does NOT itself name as a distinct item. (Example: doc says "various flavors" with no specific names; claim "2 flavors excluding Authentic" — flag, because Authentic isn't named in the doc. But if the doc literally names "Authentic" as one of the flavors, "excluding Authentic" is a valid set-difference and the exception applies.)

${SILENCE}

JSON schema:
{"confidence": <integer 0-100>}`;

const C2_AFTER_C1 = (claim, context) => `Now verify the SAME claim against the provided context document:

"""
${context}
"""

${C2_BODY}`;

const C2_STANDALONE = (claim, context) => `Verify this factual claim against the provided context document:

"${claim}"

Context document:
"""
${context}
"""

${C2_BODY}`;

const C3 = `Re-evaluate critically with the LITERAL SUPPORT bar. Internally check:

  1. Did I score high because the document EXPLICITLY states the claim, or because the claim is a reasonable inference?
  2. Is there a specific passage that directly states the claim?
  3. Did I bridge any gap with my own knowledge, common sense, or "would naturally follow"?
  4. Does the claim add a qualifier the document doesn't itself raise?

If the support is anything less than literal — "implies", "suggests", "follows from", "consistent with", "would mean" — lower confidence below 90. ONLY keep confidence ≥ 90 if the document directly states this exact claim.

EXCEPTION — VERIFIABLE AGGREGATIONS: Do NOT lower the score below 90 if the claim is a simple count, sum, ranking, set-difference, or max/min over items the document LITERALLY and unambiguously enumerates (e.g. doc lists Authentic, Honey Lemon, Goji Berry → "2 additional flavors excluding Authentic" stays 90+; doc states quarterly numbers → "Q3 was the lowest" stays 90+). The aggregation must be deterministic over literal items. This exception does NOT apply to qualitative quantifiers ("many", "several"), open-ended lists ("such as X, etc."), aggregations across uncombined categories, or qualifiers naming items the document never named.

Adjust honestly. The pipeline depends on the gate flagging inference-based claims even when they sound true — but verifiable aggregations over literal enumerations are not the kind of inference the gate is meant to catch.

${SILENCE}

JSON schema:
{"confidence": <integer 0-100>}`;

// ── Validation ──────────────────────────────────────────────────────────────
// Allowed configs: TTT, TTF, FTT, FTF. The single rule that captures all four:
// c2 must be true. (c3 without c2 makes no sense; c2 is the always-on grounded
// check.)
function validateGateConfig({ gate_c1_enabled, gate_c2_enabled, gate_c3_enabled }) {
  if (gate_c2_enabled !== true) {
    throw new Error(
      `gate_c2_enabled must be true. Allowed configs: TTT, TTF, FTT, FTF ` +
      `(got c1=${gate_c1_enabled} c2=${gate_c2_enabled} c3=${gate_c3_enabled}).`
    );
  }
}

// ── Parsing ─────────────────────────────────────────────────────────────────
function parseConf(s) {
  try {
    const j = extractJson(s);
    let n = parseInt(j.confidence, 10);
    if (Number.isNaN(n)) n = 0;
    n = Math.max(0, Math.min(100, n));
    return { reasoning: String(j.reasoning ?? ''), confidence: n };
  } catch {
    // Gate is permissive on parse failures: return confidence=0 so the claim
    // gets flagged rather than crashing the whole example.
    return { reasoning: '(parse failed)', confidence: 0 };
  }
}

// ── Per-claim execution ─────────────────────────────────────────────────────
async function gateOneClaim({
  claim, context, model,
  threshold = 90,
  gate_c1_enabled = true, gate_c2_enabled = true, gate_c3_enabled = true,
  log,
}) {
  validateGateConfig({ gate_c1_enabled, gate_c2_enabled, gate_c3_enabled });

  const buf = [];
  const push = s => buf.push(s);

  push(`╭─ claim ${claim.id} (sentence ${claim.sentence_idx}) ──────────────────────`);
  push(`│ ${claim.text}`);
  push(`│ stages: c1=${gate_c1_enabled?'T':'F'} c2=${gate_c2_enabled?'T':'F'} c3=${gate_c3_enabled?'T':'F'}`);

  const messages = [];
  let c1 = null, c2 = null, c3 = null;

  // c1 — only if enabled
  if (gate_c1_enabled) {
    const p1 = C1(claim.text);
    push(`├── c1 prompt (parametric) ──`);
    push(p1.split('\n').map(l => '│  ' + l).join('\n'));
    messages.push({ role: 'user', content: p1 });
    const r1 = await callArchitectureModel({ model, messages, max_tokens: 512 });
    push(`├── c1 response ──`);
    push(r1.text.split('\n').map(l => '│  ' + l).join('\n'));
    c1 = parseConf(r1.text);
    messages.push({ role: 'assistant', content: r1.text });
    push(`│ c1 confidence = ${c1.confidence}`);
  }

  // c2 — always runs (validated above)
  const p2 = gate_c1_enabled ? C2_AFTER_C1(claim.text, context) : C2_STANDALONE(claim.text, context);
  push(`├── c2 prompt (${gate_c1_enabled ? 'continuation' : 'standalone'}, grounded) ──`);
  const p2head = p2.slice(0, 220);
  const p2tail = p2.slice(-220);
  push(`│  ${p2head}\n│  …[context truncated for log; ${context.length} chars]…\n│  ${p2tail}`);
  messages.push({ role: 'user', content: p2 });
  const r2 = await callArchitectureModel({ model, messages, max_tokens: 512 });
  push(`├── c2 response ──`);
  push(r2.text.split('\n').map(l => '│  ' + l).join('\n'));
  c2 = parseConf(r2.text);
  messages.push({ role: 'assistant', content: r2.text });
  push(`│ c2 confidence = ${c2.confidence}`);

  // c3 — only if enabled (always after a c2 turn that loaded the source)
  if (gate_c3_enabled) {
    push(`├── c3 prompt (confrontation) ──`);
    push(C3.split('\n').map(l => '│  ' + l).join('\n'));
    messages.push({ role: 'user', content: C3 });
    const r3 = await callArchitectureModel({ model, messages, max_tokens: 512 });
    push(`├── c3 response ──`);
    push(r3.text.split('\n').map(l => '│  ' + l).join('\n'));
    c3 = parseConf(r3.text);
    push(`│ c3 confidence = ${c3.confidence}`);
  }

  // Flag rule: rightmost-enabled stage's confidence determines.
  const lastEnabled = gate_c3_enabled ? c3 : c2;
  const flagged = lastEnabled.confidence < threshold;

  const summary =
    `c1=${c1 ? c1.confidence : '-'} ` +
    `c2=${c2.confidence} ` +
    `c3=${c3 ? c3.confidence : '-'} ` +
    `(flag from ${gate_c3_enabled ? 'c3' : 'c2'}=${lastEnabled.confidence})`;
  push(`╰─ id=${claim.id} ${summary} → ${flagged ? '⊘ FLAGGED' : '✓ PASS'} (threshold=${threshold})`);

  log?.(buf.join('\n'));
  return { ...claim, c1, c2, c3, flagged };
}

async function gateAllClaims({
  claims, context, model,
  threshold = 90,
  gate_c1_enabled = true, gate_c2_enabled = true, gate_c3_enabled = true,
  concurrency = 5, log,
}) {
  validateGateConfig({ gate_c1_enabled, gate_c2_enabled, gate_c3_enabled });
  const out = new Array(claims.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= claims.length) break;
      out[i] = await gateOneClaim({
        claim: claims[i], context, model, threshold,
        gate_c1_enabled, gate_c2_enabled, gate_c3_enabled,
        log,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, claims.length) }, worker));
  return out;
}

module.exports = {
  gateOneClaim, gateAllClaims, validateGateConfig,
  C1, C2_AFTER_C1, C2_STANDALONE, C3,
};
