// 3-judge eligibility panel for FACTS Grounding (paper-aligned).
// Runs Gemini 2.5 Pro, GPT-5, and Claude Sonnet 4.6 in parallel against the
// same eligibility prompt as the single-judge path. A response is Ineligible
// only if ALL THREE judges return "Ineligible" (unanimous). Any single
// Eligible verdict keeps it Eligible.
//
// Process-level cache keyed on (judge_id, sha256(system+user)) so reruns
// (e.g. re-judging baseline after a revert) don't pay for duplicate calls.

const crypto = require('crypto');

const { callJudge: callGemini } = require('./geminiClient');
const { callJudge: callOpenAI } = require('./openaiClient');
const { callClaude }            = require('./anthropicClient');
const { extractJson }           = require('./jsonExtract');

const ELIGIBILITY_SYSTEM = `You are an eligibility judge for the FACTS Grounding benchmark. You evaluate whether a model's response satisfactorily addresses the user's request given the available context document, irrespective of factual accuracy.`;

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

const ALLOWED = ['Eligible', 'Ineligible'];

const PANEL = [
  { id: 'gemini_2_5_pro',     model: 'gemini-2.5-pro',     backend: 'gemini' },
  { id: 'gpt_5',              model: 'gpt-5',              backend: 'openai' },
  { id: 'claude_sonnet_4_6',  model: 'claude-sonnet-4-6',  backend: 'anthropic' },
];

// ── parse + cache ───────────────────────────────────────────────────────────
function parseVerdict(s) {
  const j = extractJson(s);
  let verdict = String(j.verdict || '').trim();
  for (const a of ALLOWED) if (verdict.toLowerCase() === a.toLowerCase()) { verdict = a; break; }
  return { verdict, reasoning: String(j.reasoning ?? '') };
}

const _cache = new Map();
function cacheKey(judgeId, system, user) {
  const h = crypto.createHash('sha256').update(judgeId).update('\0').update(system || '').update('\0').update(user).digest('hex');
  return h;
}

// ── per-backend dispatch ────────────────────────────────────────────────────
async function callBackend({ backend, model, system, user }) {
  if (backend === 'gemini')    return callGemini({ model, system, user, json: true });
  if (backend === 'openai')    return callOpenAI({ model, system, user, json: true });
  if (backend === 'anthropic') {
    const r = await callClaude({
      model,
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 512,
    });
    return { text: r.text, raw: r.raw };
  }
  throw new Error(`unknown backend: ${backend}`);
}

async function callOneJudge({ judge, system, user, log }) {
  const key = cacheKey(judge.id, system, user);
  if (_cache.has(key)) {
    log?.(`panel·${judge.id} cache hit`);
    return _cache.get(key);
  }
  let raw, parsed, firstErr;
  const tryOnce = async tag => {
    log?.(`panel·${judge.id} ${tag} → ${judge.model}`);
    const r = await callBackend({ backend: judge.backend, model: judge.model, system, user });
    log?.(`panel·${judge.id} ${tag} ← ${r.text.length} chars`);
    return r;
  };
  try {
    raw = await tryOnce('try1');
    parsed = parseVerdict(raw.text);
  } catch (e1) {
    firstErr = e1;
    log?.(`panel·${judge.id} try1 parse failed: ${e1.message} — retrying`);
    raw = await tryOnce('try2');
    try { parsed = parseVerdict(raw.text); }
    catch (e2) {
      throw new Error(`panel·${judge.id} JSON parse failed twice: ${e2.message} | first: ${firstErr.message} | last raw: ${(raw.text || '').slice(0, 200)}`);
    }
  }
  if (!ALLOWED.includes(parsed.verdict))
    throw new Error(`panel·${judge.id} verdict not Eligible/Ineligible: ${JSON.stringify(parsed)}`);
  const out = { verdict: parsed.verdict, reasoning: parsed.reasoning, raw_text: raw.text };
  _cache.set(key, out);
  return out;
}

// ── public ──────────────────────────────────────────────────────────────────
async function judgeEligibilityPanel({ example, response, log }) {
  const user = eligibilityUser({
    user_request:     example.user_request,
    context_document: example.context,
    response,
  });

  const settled = await Promise.all(
    PANEL.map(async judge => {
      try {
        const r = await callOneJudge({ judge, system: ELIGIBILITY_SYSTEM, user, log });
        return [judge.id, r];
      } catch (err) {
        log?.(`panel·${judge.id} FAILED: ${err.message}`);
        // Re-throw — caller decides whether the run is recoverable. Hiding a
        // judge failure as silent abstention would silently bias the panel.
        throw err;
      }
    })
  );

  const block = Object.fromEntries(settled);
  const verdicts = Object.values(block).map(v => v.verdict);
  const unanimous_ineligible = verdicts.every(v => v === 'Ineligible');
  const eligibility_verdict  = unanimous_ineligible ? 'Ineligible' : 'Eligible';

  return {
    ...block,
    unanimous_ineligible,
    eligibility_verdict,
  };
}

function _resetCacheForTests() { _cache.clear(); }

module.exports = { judgeEligibilityPanel, PANEL, _resetCacheForTests };
