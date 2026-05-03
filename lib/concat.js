// v4 — claim-level drop. NO model call.
// Every flagged claim is dropped from its sentence. Surviving claim texts are
// re-emitted in id order. Any sentence that loses at least one claim counts
// in n_sentences_dropped (per the v4 spec), even when other claims from the
// same sentence survive and contribute to the rewrite.
//
// Sentence-level decisions:
//   - 0 claims extracted   → keep verbatim, count as kept
//   - 0 flagged claims     → keep verbatim, count as kept
//   - all claims flagged   → drop sentence entirely, count as dropped
//   - some claims flagged  → emit surviving claim texts joined with ". " in id
//                            order (extractor's atomic forms), count as dropped

function rewriteResponse({ sentences, claims }) {
  const bySent = new Map();
  claims.forEach(c => {
    if (!bySent.has(c.sentence_idx)) bySent.set(c.sentence_idx, []);
    bySent.get(c.sentence_idx).push(c);
  });

  const surviving = [];
  const per_sentence_flag_rates = [];
  let kept_clean = 0;   // sentences with 0 dropped claims (verbatim)
  let partial    = 0;   // sentences where some claims dropped, some kept
  let full_drop  = 0;   // sentences where every claim dropped (no output)

  sentences.forEach((sent, idx) => {
    const cs        = bySent.get(idx) ?? [];
    const flagged   = cs.filter(c =>  c.flagged);
    const passed    = cs.filter(c => !c.flagged).sort((a, b) => a.id - b.id);
    const flag_rate = cs.length === 0 ? 0 : flagged.length / cs.length;
    per_sentence_flag_rates.push(flag_rate);

    if (cs.length === 0 || flagged.length === 0) {
      surviving.push(sent);
      kept_clean++;
    } else if (passed.length === 0) {
      full_drop++;
    } else {
      const joined = passed.map(c => c.text.replace(/\.\s*$/, '')).join('. ') + '.';
      surviving.push(joined);
      partial++;
    }
  });

  // n_sentences_dropped counts BOTH partial and full drops per the v4 spec.
  return {
    rewritten_response:        surviving.join(' ').trim(),
    n_sentences_total:         sentences.length,
    n_sentences_kept:          kept_clean,
    n_sentences_dropped:       partial + full_drop,
    n_sentences_partial:       partial,
    n_sentences_fully_dropped: full_drop,
    per_sentence_flag_rates,
  };
}

module.exports = { rewriteResponse };
