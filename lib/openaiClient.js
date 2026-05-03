// OpenAI client wrapper — judge calls (callJudge) and multi-turn architecture
// calls (callChat). gpt-5 occasionally rejects `response_format` or
// `temperature`; the helpers retry without those params on a 400 BadRequest so
// the judge never silently breaks the pipeline. Adds 429/503 retry+backoff on
// top so the parallel batch path tolerates rate limits.

const OpenAI = require('openai');

let _client;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS  = 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503) return true;
  const msg = String(err?.message || '');
  return /rate.?limit|overloaded|timeout|ECONNRESET|EAI_AGAIN/i.test(msg);
}

function isParamRejection(err) {
  const msg = err?.message || String(err);
  return /400|BadRequest|unsupported|deprecated|temperature|response_format/i.test(msg);
}

// gpt-5: reasoning model with `reasoning_effort` knob, accepts "minimal"
// gpt-5.{1,2,4,5}: reasoning model where the knob accepts "none"
// non-reasoning models (gpt-4o, etc): param omitted entirely
function reasoningEffortFor(model) {
  if (model === 'gpt-5')               return 'minimal';
  if (/^gpt-5\.[1-5]\b/.test(model))   return 'none';
  return undefined;
}

async function attemptOnce({ model, baseMsgs, variant }) {
  const params = { model, messages: baseMsgs };
  if (variant.temperature !== undefined) params.temperature = variant.temperature;
  if (variant.response_format)            params.response_format = variant.response_format;
  const eff = reasoningEffortFor(model);
  if (eff !== undefined)                  params.reasoning_effort = eff;
  const r = await client().chat.completions.create(params);
  const text = r.choices?.[0]?.message?.content ?? '';
  return { text, raw: r, params_used: variant };
}

async function callJudge({ model, system, user, json = true }) {
  const baseMsgs = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: user },
  ];

  const variants = [
    { temperature: 0, response_format: json ? { type: 'json_object' } : undefined },
    { temperature: 0 },          // drop response_format
    {},                           // drop temperature too
  ];

  let lastErr;
  for (const v of variants) {
    // Each variant gets its own retry loop for transient errors.
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await attemptOnce({ model, baseMsgs, variant: v });
      } catch (err) {
        lastErr = err;
        if (isRetryable(err) && attempt < MAX_RETRIES) {
          const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) + Math.floor(Math.random() * 500);
          console.warn(`[openai] retry ${attempt + 1}/${MAX_RETRIES} after ${(delay / 1000).toFixed(1)}s — ${err?.status ?? '?'} ${(err?.message || '').slice(0, 80)}`);
          await sleep(delay);
          continue;
        }
        if (isParamRejection(err)) break;   // try next variant
        throw err;                          // fatal
      }
    }
  }
  throw lastErr;
}

// Multi-turn chat for architecture (model-under-test) usage. Anthropic-shaped
// inputs: `system` is a separate string, `messages` is [{role, content}] with
// roles 'user' | 'assistant'. We prepend system as a 'system' message for
// OpenAI. No JSON-mode forcing here — the architecture path is free-form text.
// The variant chain handles gpt-5 rejecting `temperature` (and any unrelated
// param-rejection 400s) by retrying without the offending param.
async function callChat({ model, system, messages, max_tokens, temperature = 0 }) {
  const baseMsgs = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  const variants = [
    { temperature, max_completion_tokens: max_tokens },
    { max_completion_tokens: max_tokens },     // drop temperature
    {},                                        // drop max_completion_tokens too
  ];

  let lastErr;
  for (const v of variants) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const params = { model, messages: baseMsgs };
        if (v.temperature !== undefined)             params.temperature = v.temperature;
        if (v.max_completion_tokens !== undefined)   params.max_completion_tokens = v.max_completion_tokens;
        const eff = reasoningEffortFor(model);
        if (eff !== undefined)                       params.reasoning_effort = eff;
        const r = await client().chat.completions.create(params);
        const text = r.choices?.[0]?.message?.content ?? '';
        return { text, raw: r, usage: r.usage, params_used: v };
      } catch (err) {
        lastErr = err;
        if (isRetryable(err) && attempt < MAX_RETRIES) {
          const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) + Math.floor(Math.random() * 500);
          console.warn(`[openai·chat] retry ${attempt + 1}/${MAX_RETRIES} after ${(delay / 1000).toFixed(1)}s — ${err?.status ?? '?'} ${(err?.message || '').slice(0, 80)}`);
          await sleep(delay);
          continue;
        }
        if (isParamRejection(err)) break;
        throw err;
      }
    }
  }
  throw lastErr;
}

module.exports = { callJudge, callChat, reasoningEffortFor };
