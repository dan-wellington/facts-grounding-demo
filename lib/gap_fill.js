// v3 — gap-fill phase. Inserted between sentence-threshold suppression and
// final judging. Two model calls plus a per-gap generator (parallel cap 5).
// Generated sentences go through the standard atomic-claim gate before
// being appended to the v2 rewrite.

const { callArchitectureModel } = require('./architectureClient');
const { extractClaims }         = require('./extractor');
const { gateAllClaims }         = require('./gate');
const { extractJson }           = require('./jsonExtract');

// ── prompts ────────────────────────────────────────────────────────────────
const ANALYSIS_SYSTEM = `You analyse model responses for gaps relative to the user request and a context document. You produce strict JSON only — no commentary, no markdown.`;

const analysisUser = ({ userRequest, context, rewriteText }) =>
`You are reviewing a response that has had unsupported claims removed. Identify gaps that prevent the response from fully addressing the user request — but ONLY gaps that are inside the user request's specific scope.

A gap counts ONLY IF ALL three of these are true:
  1. Filling the gap would DIRECTLY answer the user request as worded — not a related question, not a broader topic, not a tangent.
  2. The context document contains specific, quotable evidence that fills the gap.
  3. The evidence in the document is framed in the SAME scope as the user request. If the user asks about X and the document discusses both X and a broader umbrella Y (where X ⊂ Y), only quote evidence that is explicitly about X. Do NOT promote evidence from Y to X — that is a scope-creep gap and you must reject it.

Concrete examples of REJECTABLE scope-creep gaps:
  • User asks about "industries created or accelerated by robotic ecosystems"; document discusses "automation" broadly and "robotic ecosystems" specifically as one slice. A gap that pulls in automation-only content (e.g., generic "automation will drive labor-market friction") is REJECTED, because the user asked about robotic ecosystems, not automation.
  • User asks about "side effects of drug X"; document discusses drug X and its drug class. A gap that pulls in class-wide effects not tied specifically to X is REJECTED.
  • User asks about "Q3 revenue"; document discusses Q3 revenue and full-year revenue. A gap that brings in full-year figures is REJECTED.

If a piece of document content might be relevant but is framed in a broader/related scope than the user request, leave it out. Better an empty gap list than a tangential one. The benchmark penalises responses that mix scopes.

Each gap should describe what is missing in concrete terms tied to the user request's exact framing. Do not list stylistic concerns. Do not invent gaps. If the response fully addresses the request within its scope, return an empty list.

User request:
"""
${userRequest}
"""

Context document:
"""
${context}
"""

Response (post-suppression):
"""
${rewriteText}
"""

For each gap, the "context_evidence" must be a verbatim quote from the document AND must use the same scope/framing as the user request. If you cannot find quotable evidence in the user-request scope, do not emit the gap.

Output strict JSON, no prose, no markdown:
{
  "gaps": [
    {"id": 1, "description": "specific missing content (in the user-request's scope)", "context_evidence": "verbatim quote from context document, in scope"},
    ...
  ]
}`;

const GENERATION_SYSTEM = `You generate fill-in sentences for a partially-suppressed response, strictly grounded in a provided context document. You produce strict JSON only — no commentary, no markdown.`;

const generationUser = ({ userRequest, context, rewriteText, gap }) =>
`Generate one or two PROSE sentences that fill the following gap in the response, plus a short bullet title.

Strict requirements:
  • The sentences must be grounded in the context document — state only what the document directly supports. Do not add information beyond the document.
  • The sentences must be plain prose. Do NOT include any markdown bullets, dashes, or list glyphs (no leading "•", "-", "*", or "1.").
  • The sentences must NOT contain bold/italic markdown headers ("**...**" or "*...*").
  • The sentences must NOT begin with a heading-like phrase such as "Title - body". Just write the sentence.
  • The "title" field is a SHORT (2–5 words) noun-phrase title that names the missing topic in the same framing the user asked about. Examples: "Agriculture", "Recruiting and Training Industry", "Productivity Boost by Sector". Do NOT begin the title with "Additional", "More", "Other", or framing words; name the topic itself.

User request:
"""
${userRequest}
"""

Context document:
"""
${context}
"""

Existing response:
"""
${rewriteText}
"""

Gap: ${gap.description}

Output strict JSON, no prose, no markdown:
{"title": "Topic Name", "sentences": ["...", "..."]}

Output a maximum of 2 sentences.`;

// ── parsing ────────────────────────────────────────────────────────────────
const parseJson = extractJson;

async function callWithRetry({ model, system, user, max_tokens, log, tag }) {
  const attempt = async retryTag => {
    log?.(`${tag} ${retryTag} → ${model}`);
    const r = await callArchitectureModel({
      model, system,
      messages: [{ role: 'user', content: user }],
      max_tokens,
    });
    return r;
  };
  let raw, parsed, firstErr;
  try {
    raw = await attempt('try1');
    parsed = parseJson(raw.text);
  } catch (e1) {
    firstErr = e1;
    log?.(`${tag} try1 parse failed: ${e1.message} — retrying`);
    raw = await attempt('try2');
    try { parsed = parseJson(raw.text); }
    catch (e2) { throw new Error(`${tag} JSON parse failed twice: ${e2.message} | first: ${firstErr.message} | last raw: ${raw.text.slice(0,200)}`); }
  }
  return { parsed, raw_text: raw.text };
}

// ── public ─────────────────────────────────────────────────────────────────

// Step A
async function identifyGaps({ userRequest, context, rewriteText, model, log }) {
  const { parsed, raw_text } = await callWithRetry({
    model, system: ANALYSIS_SYSTEM,
    user: analysisUser({ userRequest, context, rewriteText }),
    max_tokens: 2048, log, tag: 'gap·analysis',
  });
  const gaps = (Array.isArray(parsed.gaps) ? parsed.gaps : []).map((g, i) => ({
    id:               Number.isInteger(g.id) ? g.id : i + 1,
    description:      String(g.description || '').trim(),
    context_evidence: String(g.context_evidence || '').trim(),
  })).filter(g => g.description);
  return { gaps, raw_text };
}

// Step B (per-gap, parallelised by caller). Returns a short bullet title plus
// 1-2 prose sentences. Sentences are sanitised: any leading bullet glyph or
// "**Title** - " scaffolding is stripped (defensive — the prompt forbids it,
// but models occasionally emit it anyway when the surrounding response is
// bullet-formatted).
async function generateGapFill({ userRequest, context, rewriteText, gap, model, log }) {
  const { parsed, raw_text } = await callWithRetry({
    model, system: GENERATION_SYSTEM,
    user: generationUser({ userRequest, context, rewriteText, gap }),
    max_tokens: 512, log, tag: `gap·gen[${gap.id}]`,
  });
  const sentences = (Array.isArray(parsed.sentences) ? parsed.sentences : [])
    .map(s => sanitizeGapSentence(String(s || '')))
    .filter(Boolean)
    .slice(0, 2);
  const title = String(parsed.title || '').trim().replace(/^\*+|\*+$/g, '').trim();
  return { title, sentences, raw_text };
}

// Strip leading bullet/list/heading scaffolding from a generated sentence so
// the orchestrator can wrap it in its own bullet without producing nested
// "• **Title** - • **Inner** - ..." double-bullets.
function sanitizeGapSentence(s) {
  let t = s.trim();
  // Repeatedly strip leading list glyphs and "**Title** -/—/–" prefixes.
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^[\s]*[•\-\*][\s]+/, '');                          // • / - / *
    t = t.replace(/^[\s]*\d+[.)][\s]+/, '');                          // 1. / 1)
    t = t.replace(/^\*\*[^*\n]{1,80}\*\*\s*[-–—:]\s*/, '');           // **Title** - body
    t = t.replace(/^\*[^*\n]{1,80}\*\s*[-–—:]\s*/, '');               // *Title* - body
    if (t === before) break;
  }
  return t.trim();
}

// Tiny parallelism helper.
async function pmap(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// Step D — gate proposed gap-fill sentences. v4 semantics: drop the whole
// proposed sentence if ANY of its claims is flagged. No threshold.
// v5: stage toggles (gate_c{1,2,3}_enabled) inherited from the parent run.
// v6.3: each item carries gap_id / gap_description so the orchestrator can
// rebuild structured gap-fill bullets without misattributing them.
async function gateGapFillSentences({
  proposals, context, model, primary_threshold,
  gate_c1_enabled = true, gate_c2_enabled = true, gate_c3_enabled = true,
  log,
}) {
  if (!proposals.length) return { survivors: [], details: [] };
  const details = await pmap(proposals, 3, async (item, i) => {
    const sentence = item.text;
    const ext = await extractClaims({ response: sentence, model, onLog: log });
    const gated = await gateAllClaims({
      claims: ext.claims, context, model,
      threshold: primary_threshold, concurrency: 3,
      gate_c1_enabled, gate_c2_enabled, gate_c3_enabled,
    });
    const flagged = gated.filter(c => c.flagged).length;
    const flag_rate = gated.length === 0 ? 0 : flagged / gated.length;
    const kept = flagged === 0;
    return {
      idx: i, sentence,
      gap_id:          item.gap_id,
      gap_description: item.gap_description,
      gap_title:       item.gap_title,
      n_claims: gated.length, n_flagged: flagged, flag_rate, kept,
    };
  });
  const survivors = details.filter(d => d.kept).map(d => ({
    text:            d.sentence,
    gap_id:          d.gap_id,
    gap_description: d.gap_description,
    gap_title:       d.gap_title,
  }));
  return { survivors, details };
}

// Orchestrator — full A → B → C → D pipeline. Returns the gap-fill bundle to
// merge into the per-example record.
async function gapFillPhase({
  userRequest, context, v2_rewrite, n_sentences_dropped,
  primary_threshold,
  gate_c1_enabled = true, gate_c2_enabled = true, gate_c3_enabled = true,
  model, log,
}) {
  // Step A
  const { gaps } = await identifyGaps({ userRequest, context, rewriteText: v2_rewrite, model, log });
  if (!gaps.length) {
    return {
      gaps_identified:               [],
      gap_fill_sentences_proposed:   0,
      gap_fill_sentences_after_cap:  0,
      gap_fill_sentences_after_gate: 0,
      survivors:                     [],
      gate_details:                  [],
    };
  }

  // Step B — parallel, cap 5. Track gap origin so the orchestrator can rebuild
  // gap-fill output as its own labeled bullet rather than tail-appending into
  // whatever the last sentence of the rewrite happens to be.
  const genResults = await pmap(gaps, 5, gap =>
    generateGapFill({ userRequest, context, rewriteText: v2_rewrite, gap, model, log })
  );
  let proposed = [];
  genResults.forEach((r, i) => {
    const gap = gaps[i];
    const title = r.title || '';
    r.sentences.forEach(s => proposed.push({
      text: s,
      gap_id: gap.id,
      gap_description: gap.description,
      gap_title: title,
    }));
  });
  const proposed_count = proposed.length;

  // Step C — hard cap to n_sentences_dropped
  if (proposed.length > n_sentences_dropped) proposed = proposed.slice(0, n_sentences_dropped);
  const after_cap = proposed.length;

  // Step D — gate (inherits the run's stage toggles)
  const { survivors, details } = await gateGapFillSentences({
    proposals: proposed, context, model,
    primary_threshold,
    gate_c1_enabled, gate_c2_enabled, gate_c3_enabled,
    log,
  });

  return {
    gaps_identified:               gaps,
    gap_fill_sentences_proposed:   proposed_count,
    gap_fill_sentences_after_cap:  after_cap,
    gap_fill_sentences_after_gate: survivors.length,
    survivors,
    gate_details:                  details,
  };
}

module.exports = { identifyGaps, generateGapFill, gateGapFillSentences, gapFillPhase, pmap };
