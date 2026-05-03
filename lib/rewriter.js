// Surgical rewrite — replaces the v4 claim-level concat (which re-emitted
// extracted atomic-claim phrasings as fragments and destroyed any non-prose
// structure) with a single architecture-model call that edits the original
// baseline in place. Preserves bullets / lists / headers / paragraphs /
// numbering, removing only content corresponding to flagged atomic claims.
//
// Bypassed when there are 0 flagged claims (output = baseline verbatim).
// On model failure (empty output or error), falls back to the pristine
// baseline so the pipeline never ships an unprintable result.

const { callArchitectureModel } = require('./architectureClient');

const SYSTEM = `You are a careful editor. You receive a model response, the user's original question, and a list of atomic claims that have been flagged for removal as unsupported. You produce a minimally-edited version of the response with the flagged content removed — UNLESS removing it would leave the response unable to answer the user's question, in which case you preserve the minimum content needed to keep the answer intact.`;

function userPrompt({ original, flagged_claims, user_request }) {
  const claimsList = flagged_claims.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `Below is a model response, the user's question, and a list of atomic claims flagged as unsupported. Edit the response to remove the flagged content while preserving the response's ability to answer the user's question.

USER QUESTION:
"""
${user_request || '(not provided)'}
"""

ORIGINAL RESPONSE:
"""
${original}
"""

CLAIMS FLAGGED FOR REMOVAL:
${claimsList}

ANSWER-ESSENTIALITY CHECK (do this silently before editing):
For each flagged claim, ask: "is this claim the answer (or part of the answer) to the user's question?" — e.g. the user asked "how many X" and the flagged claim is the count; or the user asked "which Y" and the flagged claim names Y.
  • If YES (claim IS the answer or part of it): KEEP the claim. Removing it would defeat the purpose of the response. Edit nothing related to that claim.
  • If NO (claim is unrelated peripheral content): REMOVE it as instructed.

The point of removing flagged claims is to drop unsupported peripheral content, not to gut the response of its answer. A response that no longer answers the user's question is worse than one with a slightly-inferred answer.

Editing rules:
- Preserve the response's formatting EXACTLY: bullet points stay bullet points, numbered lists stay numbered, paragraphs stay paragraphs, headers stay headers, line breaks stay where they are.
- Keep all unflagged content verbatim — do not paraphrase, restructure, reorder, or "improve" anything that should be kept.
- For a flagged claim you decided to REMOVE:
    • If the entire item is the flagged claim, remove the whole item.
    • If only part is flagged, remove just that part and keep the rest, fixing only essential punctuation/spacing.
- The flagged claims are atomic paraphrases — they may not appear verbatim in the response. Match them by meaning. If a flagged claim does not appear, leave the response unchanged.
- Do NOT introduce new content, claims, qualifications, hedges, commentary, headings, framing, summary, or apologies of your own.

Output the edited response only. No preamble. No commentary.`;
}

async function surgicalRewrite({ original, flagged_claims, user_request, model, log }) {
  if (!flagged_claims || flagged_claims.length === 0) {
    return { rewritten: original, used_model: false };
  }
  log?.(`surgical → ${model} (${flagged_claims.length} flagged claims, ${original.length} chars in)`);
  try {
    const r = await callArchitectureModel({
      model,
      system:   SYSTEM,
      messages: [{ role: 'user', content: userPrompt({ original, flagged_claims, user_request }) }],
      // Headroom: at most we keep everything; pad for reasoning models that
      // burn output budget on internal thinking (e.g. gemini-2.5-pro).
      max_tokens: Math.max(2048, Math.ceil(original.length * 1.5)),
      temperature: 0,
    });
    const text = (r.text || '').trim();
    if (!text) {
      log?.('surgical empty output — falling back to baseline');
      return { rewritten: original, used_model: true, fallback: 'empty_output' };
    }
    log?.(`surgical ← ${text.length} chars`);
    return { rewritten: text, used_model: true, fallback: null };
  } catch (err) {
    log?.(`surgical failed: ${err.message?.slice(0, 120)} — falling back to baseline`);
    return { rewritten: original, used_model: true, fallback: 'error', error: err.message };
  }
}

module.exports = { surgicalRewrite };
