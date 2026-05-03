// Surgical reinsertion — replaces the mechanical composeV3() bullet-append
// with a single architecture-model call that integrates gap-fill survivor
// sentences into the (post-surgical) response while preserving the original's
// format, structure, and voice.
//
// Why a model and not composeV3:
//   • composeV3 always added a NEW bullet, even when the user asked for a
//     specific format ("answer in 1 bullet"). The judge then caught the
//     format mismatch and marked the response Inaccurate (id 293).
//   • A model can decide whether the right move is "add a labeled bullet",
//     "fold a sentence into an existing bullet's body", or "add a sentence
//     to the prose", based on the response's actual structure.
//
// Bypassed when there are 0 additions (output = original verbatim).
// On failure, falls back to the pristine input so the pipeline never ships
// an unprintable result.

const { callArchitectureModel } = require('./architectureClient');

const SYSTEM = `You are a careful editor. You receive an existing response and a small list of new sentences to integrate into it. You produce a minimally-edited version of the response with the new content woven in, preserving everything else verbatim. You output only the rewritten response — no preamble, no commentary, no markdown fences.`;

function userPrompt({ original, additions }) {
  const list = additions.map((a, i) => {
    const title = (a.gap_title || '').trim();
    return `${i + 1}.${title ? ` [topic: ${title}]` : ''} ${a.text}`;
  }).join('\n');
  return `Below is an existing response and a list of new sentences (each with an optional topic title) that should be integrated into it.

ORIGINAL RESPONSE:
"""
${original}
"""

NEW CONTENT TO INTEGRATE:
${list}

Editing rules:
- Preserve the response's formatting EXACTLY: bullet glyph (•, -, *), numbered list style, paragraph breaks, headers, line breaks. Match what the original uses.
- Keep all original content verbatim — do not paraphrase, restructure, reorder, or "improve" any text that already exists.
- Decide where the new content belongs based on the original's shape:
    • If the response is bulleted/numbered, add each addition as its OWN new bullet/item using the same glyph the response uses. When an addition has a [topic: X] title, format the new bullet as "GLYPH **X** - addition text". Place new items after the existing items.
    • If the response is plain prose, append the additions as new sentences in a coherent paragraph.
    • If the user's request implies a tight format (single bullet, count answer, very short response) — you can tell because the original is very short or has only 1-2 bullets — DO NOT add bullets. Instead, fold the additions into the existing bullet's body or into the existing prose so the format stays the same.
- Do NOT introduce any information not present in the original or in the new content.
- Do NOT add framing, headings, commentary, summary, or apologies of your own.

Output the rewritten response only. No preamble. No quotes. No markdown fences.`;
}

async function surgicalReinsert({ original, additions, model, log }) {
  if (!additions || additions.length === 0) {
    return { rewritten: original, used_model: false, fallback: null };
  }
  log?.(`reinsert → ${model} (${additions.length} additions, ${original.length} chars in)`);
  try {
    const r = await callArchitectureModel({
      model,
      system:   SYSTEM,
      messages: [{ role: 'user', content: userPrompt({ original, additions }) }],
      // Headroom: original + additions, with padding for reasoning models.
      max_tokens: Math.max(2048, Math.ceil(original.length * 1.5) + additions.length * 240),
      temperature: 0,
    });
    const text = (r.text || '').trim();
    if (!text) {
      log?.('reinsert empty output — falling back to original');
      return { rewritten: original, used_model: true, fallback: 'empty_output' };
    }
    log?.(`reinsert ← ${text.length} chars`);
    return { rewritten: text, used_model: true, fallback: null };
  } catch (err) {
    log?.(`reinsert failed: ${err.message?.slice(0, 120)} — falling back to original`);
    return { rewritten: original, used_model: true, fallback: 'error', error: err.message };
  }
}

module.exports = { surgicalReinsert };
