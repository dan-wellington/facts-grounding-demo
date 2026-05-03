// Gemini client wrapper — judge calls (callJudge) and multi-turn architecture
// calls (callChat). Uses the v1beta generateContent REST endpoint via global
// fetch (Node 18+), so no new npm dep is required. callJudge mirrors
// openaiClient.js (single user, optional JSON mode); callChat takes an
// Anthropic-style messages array and converts to Gemini's contents shape
// (assistant → 'model'). Both share temperature 0 default and 429/5xx
// retry+backoff.

const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS  = 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isRetryable(status, msg) {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return /rate.?limit|overloaded|timeout|ECONNRESET|EAI_AGAIN|UNAVAILABLE/i.test(msg || '');
}

function extractText(payload) {
  const cands = payload?.candidates;
  if (!Array.isArray(cands) || !cands.length) return '';
  const parts = cands[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => p?.text ?? '').join('');
}

async function callJudge({ model, system, user, json = true }) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY missing');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0 },
  };
  if (system) body.systemInstruction = { role: 'system', parts: [{ text: system }] };
  if (json)   body.generationConfig.responseMimeType = 'application/json';

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res, payload;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      try { payload = JSON.parse(raw); } catch { payload = { _raw: raw }; }
      if (!res.ok) {
        const msg = payload?.error?.message || payload?._raw || res.statusText;
        const err = new Error(`gemini ${res.status}: ${String(msg).slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return { text: extractText(payload), raw: payload, params_used: { temperature: 0, json } };
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? res?.status;
      if (isRetryable(status, err?.message) && attempt < MAX_RETRIES) {
        const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) + Math.floor(Math.random() * 500);
        console.warn(`[gemini] retry ${attempt + 1}/${MAX_RETRIES} after ${(delay / 1000).toFixed(1)}s — ${status ?? '?'} ${(err?.message || '').slice(0, 80)}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Multi-turn chat for architecture (model-under-test) usage. Accepts an
// Anthropic-style `messages` array of {role, content} with roles 'user' |
// 'assistant' and converts to Gemini's `contents` shape (assistant → 'model').
// `system` becomes `systemInstruction`. No JSON mode here — architecture
// outputs are free-form.
// NOTE: max_tokens is intentionally ignored for Gemini. gemini-2.5-pro is a
// reasoning model and consumes the maxOutputTokens budget on internal
// thoughtsTokenCount before emitting visible text — passing tight Anthropic-
// style caps (e.g. 512 for gate stages) leaves zero output budget. Mirrors the
// existing callJudge path, which also omits the cap and works in production.
async function callChat({ model, system, messages, max_tokens, temperature = 0 }) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY missing');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const generationConfig = { temperature };

  const body = { contents, generationConfig };
  if (system) body.systemInstruction = { role: 'system', parts: [{ text: system }] };

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res, payload;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      try { payload = JSON.parse(raw); } catch { payload = { _raw: raw }; }
      if (!res.ok) {
        const msg = payload?.error?.message || payload?._raw || res.statusText;
        const err = new Error(`gemini ${res.status}: ${String(msg).slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return { text: extractText(payload), raw: payload, params_used: { temperature } };
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? res?.status;
      if (isRetryable(status, err?.message) && attempt < MAX_RETRIES) {
        const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) + Math.floor(Math.random() * 500);
        console.warn(`[gemini·chat] retry ${attempt + 1}/${MAX_RETRIES} after ${(delay / 1000).toFixed(1)}s — ${status ?? '?'} ${(err?.message || '').slice(0, 80)}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

module.exports = { callJudge, callChat };
