// Multi-provider dispatcher for the architecture (model-under-test) path.
// All callers in the suppression pipeline (baseline generation, gate stages,
// gap-fill) go through callArchitectureModel; provider is selected from the
// model id prefix:
//
//   claude-* → Anthropic (lib/anthropicClient.callClaude)
//   gpt-*    → OpenAI    (lib/openaiClient.callChat)
//   gemini-* → Google    (lib/geminiClient.callChat)
//
// Input contract is the Anthropic shape — `system` as a separate string and
// `messages: [{role: 'user'|'assistant', content: string}]`. Per-provider
// adapters convert as needed (OpenAI prepends a system message; Gemini moves
// system to systemInstruction and renames assistant → model). Return shape is
// `{ text, usage?, raw }` — usage is provider-specific and may be undefined.
//
// The extractor (lib/extractor.js) is intentionally NOT routed through this
// dispatcher — atomic-claim extraction is fixed-provider (Claude) because the
// rest of the pipeline depends on its structured-output reliability.

const { callClaude } = require('./anthropicClient');
const { callChat: callOpenAIChat } = require('./openaiClient');
const { callChat: callGeminiChat } = require('./geminiClient');

function providerFor(model) {
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^gpt-/.test(model))    return 'openai';
  if (/^gemini-/.test(model)) return 'gemini';
  return null;
}

async function callArchitectureModel({ model, system, messages, max_tokens = 1024, temperature = 0, log }) {
  const provider = providerFor(model);
  if (!provider) {
    throw new Error(`unknown architecture model id: "${model}" (expected claude-*, gpt-*, or gemini-*)`);
  }
  log?.(`arch·${provider} → ${model}`);
  if (provider === 'anthropic') {
    return callClaude({ model, system, messages, max_tokens, temperature });
  }
  if (provider === 'openai') {
    return callOpenAIChat({ model, system, messages, max_tokens, temperature });
  }
  return callGeminiChat({ model, system, messages, max_tokens, temperature });
}

module.exports = { callArchitectureModel, providerFor };
