// Step 5 — GPT judge. Two judges per response (factuality + eligibility) per
// the FACTS Grounding paper, so each example fires four judge calls total
// (original × {factuality, eligibility}, rewritten × {factuality, eligibility}).
// Effective accuracy = Accurate AND Eligible.
// Each judge uses temperature 0, response_format json_object when the model
// supports it, and retries once on JSON parse failure.

const { callJudge } = require('./openaiClient');

const FACTUALITY_SYSTEM = `You are a strict factuality judge for the FACTS Grounding benchmark. You evaluate whether a model's response is fully grounded in a provided context document.`;

const ELIGIBILITY_SYSTEM = `You are an eligibility judge for the FACTS Grounding benchmark. You evaluate whether a model's response satisfactorily addresses the user's request given the available context document, irrespective of factual accuracy.`;

const factualityUser = ({ system_instruction, user_request, context_document, response }) =>
`Evaluate the response below.

System instruction that was given to the model:
${system_instruction}

User request:
${user_request}

Context document:
"""
${context_document}
"""

Model's response:
"""
${response}
"""

Generate one of exactly two verdicts:
  - "Accurate"   — every factual claim in the response is fully supported by the context document.
  - "Inaccurate" — at least one claim is unsupported, contradicted, or fabricated.

ONE inaccurate or unsupported claim makes the entire response Inaccurate.

Respond with valid JSON only:
{"verdict": "Accurate" | "Inaccurate", "reasoning": "brief explanation citing what is / is not supported"}`;

const eligibilityUser = ({ user_request, context_document, response }) =>
`Determine whether the response satisfactorily addresses the user request given the available context document. This judgement is about WHETHER the response addresses the request, NOT about factual accuracy.

User request:
${user_request}

Context document:
"""
${context_document}
"""

Model's response:
"""
${response}
"""

Generate one of exactly two verdicts:
  - "Eligible"   — the response provides a usable, on-topic answer to the request, drawing on what the context document makes available. Brief or imperfect answers can still be Eligible.
  - "Ineligible" — the response fails to address the request. Examples: refusal/abstention, empty or near-empty output, off-topic content, structural mismatch with the request (asks for a list, gets a single item; asks for a comparison, gets only one side; asks for steps, gets a description).

A response can be Eligible but factually wrong, or Ineligible despite being technically true. Judge eligibility independently of factuality.

Respond with valid JSON only:
{"verdict": "Eligible" | "Ineligible", "reasoning": "brief explanation"}`;

// ── parsing ─────────────────────────────────────────────────────────────────
function parseVerdict(s, allowed) {
  const trimmed = (s || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const j = JSON.parse(fenced ? fenced[1] : trimmed);
  let verdict = String(j.verdict || '').trim();
  // Normalise to canonical casing.
  for (const a of allowed) {
    if (verdict.toLowerCase() === a.toLowerCase()) { verdict = a; break; }
  }
  return { verdict, reasoning: String(j.reasoning ?? '') };
}

async function callWithRetry({ model, system, user, allowed, log, tag }) {
  const attempt = async retryTag => {
    log?.(`judge[${tag}] ${retryTag} → calling ${model}`);
    const r = await callJudge({ model, system, user, json: true });
    log?.(`judge[${tag}] ${retryTag} ← raw (${r.text.length} chars)`);
    return r;
  };
  let raw, parsed, firstErr;
  try {
    raw = await attempt('try1');
    parsed = parseVerdict(raw.text, allowed);
  } catch (e1) {
    firstErr = e1;
    log?.(`judge[${tag}] try1 parse failed: ${e1.message} — retrying`);
    raw = await attempt('try2');
    try { parsed = parseVerdict(raw.text, allowed); }
    catch (e2) {
      throw new Error(`judge[${tag}] JSON parse failed twice: ${e2.message} | first: ${firstErr.message} | last raw: ${raw.text.slice(0, 200)}`);
    }
  }
  if (!allowed.includes(parsed.verdict))
    throw new Error(`judge[${tag}] verdict not one of ${allowed.join('/')}: ${JSON.stringify(parsed)}`);
  return { ...parsed, raw_text: raw.text };
}

// ── public ──────────────────────────────────────────────────────────────────
async function judgeFactuality({ example, response, model = process.env.JUDGE_MODEL || 'gpt-5', log }) {
  const user = factualityUser({
    system_instruction: example.system_instruction,
    user_request:       example.user_request,
    context_document:   example.context,
    response,
  });
  return callWithRetry({ model, system: FACTUALITY_SYSTEM, user, allowed: ['Accurate', 'Inaccurate'], log, tag: 'factuality' });
}

async function judgeEligibility({ example, response, model = process.env.JUDGE_MODEL || 'gpt-5', log }) {
  const user = eligibilityUser({
    user_request:     example.user_request,
    context_document: example.context,
    response,
  });
  return callWithRetry({ model, system: ELIGIBILITY_SYSTEM, user, allowed: ['Eligible', 'Ineligible'], log, tag: 'eligibility' });
}

// Back-compat: the old name is preserved as an alias for callers that don't
// care about the eligibility judge yet.
const judgeResponse = judgeFactuality;

module.exports = { judgeFactuality, judgeEligibility, judgeResponse };
