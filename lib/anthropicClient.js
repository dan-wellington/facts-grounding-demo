// Anthropic client wrapper. Opus 4.7 deprecated `temperature` — passing it
// returns 400, so the helper omits it for any opus-4-7 model id. Sonnet/Haiku
// keep temperature: 0. Retries with exponential backoff on 429/529/overloaded
// errors so the parallel batch path doesn't fail one-shot on rate limits.

const Anthropic = require('@anthropic-ai/sdk');

let _client;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const supportsTemperature = model => !/opus-4-7/.test(model);

const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS  = 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || status === 529 || status === 503) return true;
  const msg = String(err?.message || '');
  return /rate.?limit|overloaded|timeout|ECONNRESET|EAI_AGAIN/i.test(msg);
}

async function callClaude({ model, system, messages, max_tokens = 2048, temperature = 0 }) {
  const params = { model, max_tokens, messages };
  if (system) params.system = system;
  if (supportsTemperature(model)) params.temperature = temperature;

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await client().messages.create(params);
      const text = r.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return { text, usage: r.usage, raw: r };
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES) throw err;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) + Math.floor(Math.random() * 500);
      console.warn(`[anthropic] retry ${attempt + 1}/${MAX_RETRIES} after ${(delay / 1000).toFixed(1)}s — ${err?.status ?? '?'} ${(err?.message || '').slice(0, 80)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { callClaude, supportsTemperature };
