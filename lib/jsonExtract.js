// Robust JSON extraction from LLM output. Handles the three quirks that keep
// breaking strict-JSON parsing in the wild:
//   1. Markdown fences:   ```json {"k":"v"} ```
//   2. Prose preamble:    "Sure, here's the JSON: {"k":"v"}"
//   3. Prose epilogue:    {"k":"v"} Hope that helps!
//
// Strategy: strip a markdown fence if present, then scan for the first
// balanced {...} or [...] block (string-aware so quoted braces don't fool the
// counter), and parse just that. Falls back to JSON.parse on the trimmed
// input if no balanced block is found, so well-formed JSON without quirks
// still works the same.

function extractJson(text) {
  if (typeof text !== 'string') throw new Error('extractJson: input is not a string');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('extractJson: empty input');

  // 1. Pull contents out of a fenced block if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  // 2. Find the first balanced {...} or [...] block.
  const block = findFirstBalancedBlock(candidate);
  if (block !== null) return JSON.parse(block);

  // 3. Last resort: parse the whole candidate. If it's malformed, this
  // throws — caller decides what to do.
  return JSON.parse(candidate);
}

// Scans the input for the first '{' or '[' that opens a balanced block,
// respecting JSON string literals so braces inside quotes don't shift depth.
// Returns the substring of that block (inclusive of its braces), or null if
// no balanced block exists.
function findFirstBalancedBlock(s) {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '{' && ch !== '[') continue;
    const open  = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0, inString = false, escape = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === open)  depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return s.slice(i, j + 1);
      }
    }
    // Unbalanced from this opener — keep searching for a later one.
  }
  return null;
}

module.exports = { extractJson, findFirstBalancedBlock };
