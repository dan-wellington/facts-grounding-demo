// v3 pipeline orchestration. Same as v2 (sentence-threshold rewrite) plus a
// gap-fill phase between suppression and judging:
//   v2 rewrite (= v2_rewrite) → optional gap-fill → v3_rewrite → judges.
// Gap-fill triggers when drop_ratio > gap_fill_trigger_threshold AND
// n_sentences_dropped > 0; otherwise v3_rewrite == v2_rewrite.

const fs   = require('fs');
const path = require('path');
const { callArchitectureModel } = require('./architectureClient');
const { extractClaims }   = require('./extractor');
const { gateAllClaims }   = require('./gate');
const { rewriteResponse } = require('./concat');
const { surgicalRewrite }  = require('./rewriter');
const { surgicalReinsert } = require('./reinsert');
const { gapFillPhase }     = require('./gap_fill');
const { judgeFactuality } = require('./judge');
const { judgeEligibilityPanel } = require('./eligibilityPanel');

// ── STEP 1: BASELINE ─────────────────────────────────────────────────────────
async function generateBaseline({ example, model, log }) {
  const user = `Context document:\n"""\n${example.context}\n"""\n\n${example.user_request}`;
  log?.(`step1 → ${model} (system_instruction len=${example.system_instruction.length}, context len=${example.context.length}, user len=${example.user_request.length})`);
  const r = await callArchitectureModel({
    model,
    system:   example.system_instruction,
    messages: [{ role: 'user', content: user }],
    max_tokens: 1024,
  });
  log?.(`step1 ← ${r.text.length} chars (in=${r.usage?.input_tokens ?? '?'} out=${r.usage?.output_tokens ?? '?'})`);
  return { response: r.text, prompt: user, usage: r.usage };
}

// ── v3 COMPOSITION ──────────────────────────────────────────────────────────
// When the post-suppression rewrite is bullet-structured (markdown headers /
// list glyphs), naively appending gap-fill sentences with " " glues them onto
// the end of the LAST bullet's prose, which causes the judge to read them as
// a continuation/elaboration of that bullet's heading. (Real failure case:
// id 128, where retraining-industry sentences got attributed to "Supporting
// Component Industries" because they landed flush against that bullet.)
//
// Fix: detect structure, group survivors by their source gap, and emit each
// gap as its own labeled bullet so the gap-fill content is clearly its own
// section rather than an extension of an unrelated heading. For unstructured
// (plain prose) baselines, fall back to the historical space-join.
function composeV3(v2_rewrite, survivors_structured) {
  if (!survivors_structured.length) return v2_rewrite;

  // Lines starting with -, *, or • (bullets). We don't treat numbered lists
  // as bullets here because resuming numbering correctly is fraught; if it
  // matters, it'll fall back to the unstructured branch.
  const bulletRe = /^[ \t]*([-*•])[ \t]+/m;
  const m = v2_rewrite.match(bulletRe);
  if (!m) {
    // Unstructured — preserve the v2 behavior exactly.
    return (v2_rewrite + ' ' + survivors_structured.map(s => s.text).join(' ')).trim();
  }
  const glyph = m[1];

  // Group by gap_id, preserving first-appearance order. Each gap becomes one
  // bullet; sentences within a gap are joined with a single space. The bullet
  // title comes from the gap-fill generator's `gap_title` (a short noun-phrase
  // naming the topic in the user-request's framing). Without it the bullet
  // would default to "Additional Context", which the judge correctly read as
  // off-topic when the user asked specifically about, say, industries.
  const groups = new Map();
  for (const s of survivors_structured) {
    const key = s.gap_id ?? '__nogap';
    if (!groups.has(key)) groups.set(key, { title: s.gap_title || '', sentences: [] });
    groups.get(key).sentences.push(s.text);
  }

  const groupsArr = Array.from(groups.values());
  const usedTitles = new Set();
  const newBullets = groupsArr.map((g, i) => {
    let title = (g.title || '').trim();
    // Sanitise: strip wrapping ** if model included them, and any trailing
    // punctuation that'd look weird in a header.
    title = title.replace(/^\*+|\*+$/g, '').replace(/[.:,;\-–—]+$/, '').trim();
    if (!title) title = groupsArr.length === 1 ? 'Additional Detail' : `Additional Detail (${i + 1})`;
    // De-dup if the model emitted identical titles for distinct gaps.
    let final = title;
    let n = 2;
    while (usedTitles.has(final)) final = `${title} (${n++})`;
    usedTitles.add(final);
    return `${glyph} **${final}** - ${g.sentences.join(' ')}`;
  }).join('\n\n');

  return v2_rewrite.trimEnd() + '\n\n' + newBullets;
}

// ── FORMAT-CONSTRAINT DETECTION ─────────────────────────────────────────────
// When the baseline shows a tight format (single bullet / numbered item, or
// a brief total response), gap-fill's "add a new bullet" strategy can violate
// the user's implied format constraint — the canonical failure was id 293
// where the user asked for one bullet with a number, surgical removed the
// flagged answer, gap-fill resurrected it as a second bullet, and the judge
// caught the format mismatch.
//
// Heuristic: 1-2 bullet/numbered items total, or fewer than 30 words. More
// items than that means the user is implicitly asking for a list (gap-fill
// adding to it is fine); longer prose means there's room to merge a paragraph.
function isFormatConstrained(response) {
  if (!response) return false;
  const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
  const bulletLines = lines.filter(l => /^([•\-*]|\d+[.)])\s+/.test(l)).length;
  const wordCount   = response.split(/\s+/).filter(Boolean).length;
  if (bulletLines >= 1 && bulletLines <= 2) return true;
  if (wordCount < 30) return true;
  return false;
}

// ── STEP 7: PERSIST ─────────────────────────────────────────────────────────
function persistRecord({ runsDir, runId, record, meta }) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  fs.appendFileSync(path.join(dir, 'results.jsonl'), JSON.stringify(record) + '\n');
  return { dir, jsonl: path.join(dir, 'results.jsonl'), meta: metaPath };
}

// ── ORCHESTRATOR ─────────────────────────────────────────────────────────────
async function runExample({
  example, model,
  primary_threshold           = 50,
  gap_fill_trigger_threshold  = 0.40,
  revert_layer_enabled        = false,   // off by default; opt-in per run
  // v6.7: reversion_knob (renamed from revert_drop_ceiling, with INVERTED
  // semantics so the slider feels intuitive). Higher knob = MORE reverts.
  // Revert fires when (kept+partial==0)  [hard floor: empty rewrite]  OR
  // when flag_ratio > (1 - reversion_knob). At knob=0 we never revert by
  // ratio (only the empty floor). At knob=1 we revert as soon as anything
  // is flagged. Default 0.30 maintains the v4-era behavior (~7% revert rate
  // when threshold is 0.70 = 1 - 0.30).
  reversion_knob              = 0.30,
  // v6.2: surgical rewrite via the architecture model. When true (default),
  // the rewrite step calls the model to edit the original response in place,
  // preserving formatting and removing only the flagged claims. When false,
  // falls back to v4 concat.js (atomic-claim re-emission, fragmenting).
  surgical_rewrite_enabled    = true,
  // v5: gate stage toggles. Defaults reproduce v4 behavior (TTT). Allowed
  // configs: TTT, TTF, FTT, FTF — c2 must be true. Validated downstream.
  gate_c1_enabled             = true,
  gate_c2_enabled             = true,
  gate_c3_enabled             = true,
  // v6.5: when the baseline is in a tight format (single bullet, brief
  // response), skip gap-fill — it would otherwise add a second bullet and
  // violate the user's implied format constraint (id 293 failure mode).
  gap_fill_abstain_on_format  = true,
  // v6.7: max_changes_for_reversion (renamed from min_changes_for_rewrite,
  // same semantics): the maximum number of flagged claims for which we'll
  // ship baseline rather than rewrite. When n_flagged <= this, surgical is
  // skipped and the baseline is shipped as v2_rewrite. Rationale: tiny
  // edits (1-2 claim removals) often look identical to the baseline to a
  // human but get caught by the strict factuality judge as "the response
  // changed", and the rewrite scores Inaccurate even though the content is
  // mostly unchanged. Small-flag cases now pass through.
  max_changes_for_reversion   = 1,
  runId, runsDir, log,
}) {
  const stage = (name, msg) => { const line = `\n[${name}] ${msg}`; (log || console.log)(line); };
  const ts = new Date().toISOString();

  // STEP 1 — baseline.
  stage('STEP 1 · BASELINE', `model under test = ${model}`);
  const base = await generateBaseline({ example, model, log: m => stage('step1', m) });
  stage('STEP 1 · BASELINE response', '\n' + base.response);

  // STEP 2 — atomic claim extraction.
  stage('STEP 2 · EXTRACT', 'extracting atomic claims …');
  const ext = await extractClaims({
    response: base.response,
    model: process.env.EXTRACTOR_MODEL || 'claude-sonnet-4-6',
    onLog: m => stage('step2·claims', m),
  });
  stage('STEP 2 · SENTENCES', `${ext.sentences.length} sentences`);
  stage('STEP 2 · CLAIMS',    `${ext.claims.length} atomic claims`);

  // STEP 3 — confidence gate. v5: stages c1/c2/c3 individually toggleable.
  const stagesLabel = `c1=${gate_c1_enabled?'T':'F'} c2=${gate_c2_enabled?'T':'F'} c3=${gate_c3_enabled?'T':'F'}`;
  stage('STEP 3 · GATE', `primary_threshold=${primary_threshold} stages=[${stagesLabel}] concurrency=5`);
  const gated = await gateAllClaims({
    claims: ext.claims, context: example.context, model,
    threshold: primary_threshold, concurrency: 5,
    gate_c1_enabled, gate_c2_enabled, gate_c3_enabled,
    log: block => stage('step3', '\n' + block),
  });
  const nFlagged = gated.filter(g => g.flagged).length;
  stage('STEP 3 · SUMMARY', `${nFlagged}/${gated.length} claims flagged`);

  // STEP 4 — rewrite. Two paths:
  //   surgical (default, v6.2): one architecture-model call edits the original
  //     response in place, preserving formatting (bullets/lists/paragraphs)
  //     and removing only content corresponding to flagged claims.
  //   concat (legacy v4): no model call; re-emit surviving atomic claims as
  //     fragments. Available behind surgical_rewrite_enabled=false.
  // The concat output is computed in both paths because its bookkeeping
  // (n_sentences_kept/partial/fully_dropped, drop_ratio) feeds the revert
  // checks and gap-fill trigger — those describe the gating outcome, not the
  // rewrite text.
  const rewrite = rewriteResponse({
    sentences: ext.sentences, claims: gated,
  });
  const drop_ratio = rewrite.n_sentences_total === 0 ? 0
    : rewrite.n_sentences_dropped / rewrite.n_sentences_total;

  let surgical_rewrite_used = false;
  let surgical_fallback     = null;
  let surgical_skipped      = false;
  let surgical_skip_reason  = null;
  if (surgical_rewrite_enabled) {
    if (nFlagged === 0) {
      // No flagged claims = nothing to remove. Ship the baseline verbatim
      // instead of concat.js's atomic-sentence reconstruction (which destroys
      // formatting because the extractor often rewrites sentences into
      // atomic-declarative form rather than preserving original segments).
      rewrite.rewritten_response = base.response;
      surgical_skipped     = true;
      surgical_skip_reason = 'no_flagged_claims';
    } else if (nFlagged <= max_changes_for_reversion) {
      // v6.7: too few changes to bother rewriting. Small edits get caught by
      // the judge as differences from baseline anyway, so we ship pristine.
      // Inclusive: with max_changes_for_reversion=2, n_flagged of 0/1/2 all
      // skip; n_flagged of 3+ triggers the surgical rewrite.
      rewrite.rewritten_response = base.response;
      surgical_skipped     = true;
      surgical_skip_reason = `n_flagged=${nFlagged} <= max_changes_for_reversion=${max_changes_for_reversion}`;
      stage('STEP 4 · SURGICAL', `bypass — ${surgical_skip_reason}; shipping baseline`);
    } else {
      const flagged_texts = gated.filter(c => c.flagged).map(c => c.text);
      const surg = await surgicalRewrite({
        original:       base.response,
        flagged_claims: flagged_texts,
        user_request:   example.user_request,
        model,
        log: m => stage('step4·surgical', m),
      });
      rewrite.rewritten_response = surg.rewritten;
      surgical_rewrite_used      = surg.used_model === true;
      surgical_fallback          = surg.fallback ?? null;
    }
  }

  // v6.1: ceiling now compares against the claim-flag ratio, not drop_ratio.
  // drop_ratio is sentence-based and inflates whenever any single claim in a
  // sentence is flagged (the v4 strict-kept definition). The claim-flag ratio
  // matches the user's natural reading of the table ("6 of 7 claims flagged
  // = 0.857"). Persisted alongside drop_ratio for diagnostic comparison.
  const flag_ratio = gated.length === 0 ? 0 : nFlagged / gated.length;

  let s1_reverted = false;
  let s1_revert_reason = 'none';
  if (revert_layer_enabled) {
    // Two cases:
    //   1. 'empty'   — every sentence had every claim flagged, so the rewrite
    //                  has zero surviving content (kept+partial == 0). Hard
    //                  floor — never ship an empty response to the judge.
    //   2. 'knob' — claim-flag ratio exceeded the inverted reversion_knob
    //                threshold (1 - knob). Higher knob = lower threshold =
    //                more reverts. The user-facing aggressiveness dial.
    const surv_kp = rewrite.n_sentences_kept + rewrite.n_sentences_partial;
    if (surv_kp === 0) {
      s1_reverted = true; s1_revert_reason = 'empty';
    } else if (flag_ratio > (1 - reversion_knob)) {
      s1_reverted = true; s1_revert_reason = 'knob';
    }
  }

  const v2_rewrite = s1_reverted ? base.response : rewrite.rewritten_response;
  stage('STEP 4 · v2 REWRITE',
    `kept=${rewrite.n_sentences_kept}/${rewrite.n_sentences_total} dropped=${rewrite.n_sentences_dropped} ` +
    `drop_ratio=${drop_ratio.toFixed(3)}` +
    (s1_reverted ? ` ⊘ STAGE-1 REVERT (${s1_revert_reason}) → v2_rewrite=baseline` : ''));

  // STEP 5 — gap-fill phase (v3 only). Trigger only if drop_ratio crosses
  // gap_fill_trigger_threshold AND at least one sentence was actually dropped.
  let gap_fill_triggered            = false;
  let gaps_identified               = [];
  let gap_fill_sentences_proposed   = 0;
  let gap_fill_sentences_after_cap  = 0;
  let gap_fill_sentences_after_gate = 0;
  let gap_fill_survivors            = [];
  let gap_fill_gate_details         = [];
  // Total atomic claims contributed by surviving gap-fill sentences. Same
  // units as the baseline `n_claims` / `n_flagged`, so the dashboard arithmetic
  // works as `final_claims = n_claims - n_flagged + gap_fill_claims_added`.
  let gap_fill_claims_added         = 0;

  // Format-constraint detection (v6.5). Computed unconditionally for the
  // record; only acted on when gap_fill_abstain_on_format is true.
  const format_constrained = isFormatConstrained(base.response);

  // If stage-1 reverted, the pipeline TERMINATES here. No gap-fill, no stage-2
  // check — the judge sees pristine baseline.
  if (s1_reverted) {
    stage('STEP 5 · STAGE-1 REVERT', `${s1_revert_reason} — pipeline terminates, judge sees pristine baseline`);
  } else if (rewrite.n_sentences_dropped === 0) {
    stage('STEP 5 · GAP-FILL', 'bypass — n_sentences_dropped=0');
  } else if (drop_ratio <= gap_fill_trigger_threshold) {
    stage('STEP 5 · GAP-FILL', `bypass — drop_ratio=${drop_ratio.toFixed(3)} ≤ ${gap_fill_trigger_threshold}`);
  } else if (gap_fill_abstain_on_format && format_constrained) {
    stage('STEP 5 · GAP-FILL', 'bypass — baseline shows format constraint (≤2 bullets or <30 words); abstaining to preserve user-requested shape');
  } else {
    gap_fill_triggered = true;
    stage('STEP 5 · GAP-FILL', `triggered (drop_ratio=${drop_ratio.toFixed(3)} > ${gap_fill_trigger_threshold})`);
    const gapResult = await gapFillPhase({
      userRequest:                example.user_request,
      context:                    example.context,
      v2_rewrite,
      n_sentences_dropped:        rewrite.n_sentences_dropped,
      primary_threshold,
      gate_c1_enabled, gate_c2_enabled, gate_c3_enabled,
      model,
      log: m => stage('step5·gap', m),
    });
    gaps_identified               = gapResult.gaps_identified;
    gap_fill_sentences_proposed   = gapResult.gap_fill_sentences_proposed;
    gap_fill_sentences_after_cap  = gapResult.gap_fill_sentences_after_cap;
    gap_fill_sentences_after_gate = gapResult.gap_fill_sentences_after_gate;
    gap_fill_survivors            = gapResult.survivors;
    gap_fill_gate_details         = gapResult.gate_details;
    gap_fill_claims_added         = gap_fill_gate_details
      .filter(d => d.kept)
      .reduce((s, d) => s + (d.n_claims || 0), 0);
    stage('STEP 5 · GAP-FILL summary',
      `gaps=${gaps_identified.length} proposed=${gap_fill_sentences_proposed} after_cap=${gap_fill_sentences_after_cap} after_gate=${gap_fill_sentences_after_gate}`);
  }

  // Stage-2 revert layer REMOVED in v6.1. Rationale: when gap-fill produces
  // sentences that all get re-flagged by the gate, the pipeline already
  // ships the s1 reduction as v3_rewrite (gap-fill survivors length is 0,
  // so v3_rewrite = v2_rewrite). No need to cascade-revert to pristine
  // baseline — the s1 reduction is still valid. The s1 ceiling + empty
  // floor are sufficient to express "this rewrite was too aggressive."
  // s2_reverted / s2_revert_reason kept as constants in the record for
  // backward-compat with downstream consumers.
  const s2_reverted = false;
  const s2_revert_reason = 'none';

  // Build v3 final response. Stage-2 revert overrides everything → baseline.
  // Otherwise, when there are gap-fill survivors, v6.6 routes through
  // surgicalReinsert (one architecture-model call) instead of mechanical
  // composeV3 — the model decides whether to add a new bullet, fold into an
  // existing one, or weave into prose, based on the response's actual shape.
  // composeV3 retained as the fallback path when the model returns empty/error.
  let v3_rewrite;
  let response_sent_to_judge;
  let reinsert_used     = false;
  let reinsert_fallback = null;
  if (s2_reverted) {
    v3_rewrite = base.response;
    response_sent_to_judge = 'pristine (stage-2 revert cascading)';
    stage('STEP 5 · STAGE-2 REVERT', `${s2_revert_reason} — discarding stage-1 reduction; judge sees pristine baseline`);
  } else if (gap_fill_survivors.length) {
    const reins = await surgicalReinsert({
      original:  v2_rewrite,
      additions: gap_fill_survivors,
      model,
      log: m => stage('step5·reinsert', m),
    });
    if (reins.fallback) {
      // Model failed — fall back to mechanical compose so we still ship
      // *something* with the gap-fill content.
      stage('STEP 5 · REINSERT', `model fallback (${reins.fallback}) — using mechanical composeV3`);
      v3_rewrite = composeV3(v2_rewrite, gap_fill_survivors);
    } else {
      v3_rewrite = reins.rewritten;
    }
    reinsert_used     = reins.used_model === true;
    reinsert_fallback = reins.fallback ?? null;
    response_sent_to_judge = s1_reverted ? 'pristine (stage-1 revert)' : 'reduced + gap-fill';
  } else {
    v3_rewrite = v2_rewrite;
    response_sent_to_judge = s1_reverted ? 'pristine (stage-1 revert)' : 'reduced';
  }
  stage('STEP 5 · v3 REWRITE', `(sent_to_judge=${response_sent_to_judge})\n${v3_rewrite}`);

  // STEP 6 — judges. Factuality is a single gpt-5 call. Eligibility is a
  // 3-judge panel (Gemini 2.5 Pro, GPT-5, Claude Sonnet 4.6) per the FACTS
  // Grounding paper; panel verdict is "Ineligible" only on unanimous Ineligible.
  // When v3_rewrite is BIT-IDENTICAL to the baseline, we judge once and reuse.
  // This covers: any revert (s1/s2), surgical skipped with no gap-fill (small
  // n_flagged), or 0 flagged + no gap-fill. Re-judging identical text wastes
  // API budget AND introduces judge non-determinism (we observed Accurate
  // vs Inaccurate verdicts for the same string under temp=0 on id 128).
  const reverted          = s1_reverted || s2_reverted;
  const rewrite_is_baseline = v3_rewrite === base.response;
  let origFact, origPanel, rewFact, rewPanel;
  if (reverted || rewrite_is_baseline) {
    const reason = reverted
      ? `revert active (${s1_reverted ? 's1' : 's2'})`
      : 'v3_rewrite ≡ baseline (surgical skipped + no gap-fill)';
    stage('STEP 6 · JUDGE', `${reason} — reusing baseline verdicts for rewrite side`);
    [origFact, origPanel] = await Promise.all([
      judgeFactuality      ({ example, response: base.response, log: m => stage('step6·orig·fact',  m) }),
      judgeEligibilityPanel({ example, response: base.response, log: m => stage('step6·orig·panel', m) }),
    ]);
    // v3_rewrite is bit-identical to base.response in any revert path, so the
    // verdicts apply unchanged.
    rewFact  = { ...origFact };
    rewPanel = { ...origPanel };
  } else {
    stage('STEP 6 · JUDGE', `factuality=${process.env.JUDGE_MODEL || 'gpt-5'} · panel=[gemini-2.5-pro, gpt-5, claude-sonnet-4-6] · 4 groups in parallel`);
    [origFact, origPanel, rewFact, rewPanel] = await Promise.all([
      judgeFactuality      ({ example, response: base.response, log: m => stage('step6·orig·fact',  m) }),
      judgeEligibilityPanel({ example, response: base.response, log: m => stage('step6·orig·panel', m) }),
      judgeFactuality      ({ example, response: v3_rewrite,    log: m => stage('step6·rew·fact',   m) }),
      judgeEligibilityPanel({ example, response: v3_rewrite,    log: m => stage('step6·rew·panel',  m) }),
    ]);
  }
  // Back-compat shims so existing record fields keep working.
  const origElig = { verdict: origPanel.eligibility_verdict, reasoning: 'panel; see judge_panel_original' };
  const rewElig  = { verdict: rewPanel.eligibility_verdict,  reasoning: 'panel; see judge_panel_rewritten' };

  // STEP 7 — record + persist.
  const effective_original   = origFact.verdict === 'Accurate' && origElig.verdict === 'Eligible';
  const effective_rewritten  = rewFact.verdict  === 'Accurate' && rewElig.verdict  === 'Eligible';
  const flip    = !effective_original && effective_rewritten;
  const damaged =  effective_original && !effective_rewritten;

  const record = {
    example_id:                  example.id,
    model,
    primary_threshold,
    gap_fill_trigger_threshold,
    revert_layer_enabled,
    reversion_knob,
    surgical_rewrite_enabled,
    surgical_rewrite_used,
    surgical_fallback,
    surgical_skipped,
    surgical_skip_reason,
    max_changes_for_reversion,
    reinsert_used,
    reinsert_fallback,
    gate_c1_enabled,
    gate_c2_enabled,
    gate_c3_enabled,
    gap_fill_abstain_on_format,
    format_constrained,
    original_response:           base.response,
    sentences:                   ext.sentences,
    claims:                      gated,
    n_claims:                    gated.length,
    n_flagged:                   nFlagged,
    n_sentences_total:           rewrite.n_sentences_total,
    n_sentences_kept:            rewrite.n_sentences_kept,
    n_sentences_dropped:         rewrite.n_sentences_dropped,
    n_sentences_partial:         rewrite.n_sentences_partial,
    n_sentences_fully_dropped:   rewrite.n_sentences_fully_dropped,
    per_sentence_flag_rates:     rewrite.per_sentence_flag_rates,
    drop_ratio,
    flag_ratio,
    s1_reverted,
    s1_revert_reason,
    v2_rewrite,
    rewritten_response:          v2_rewrite,         // back-compat alias
    gap_fill_triggered,
    gaps_identified,
    gap_fill_sentences_proposed,
    gap_fill_sentences_after_cap,
    gap_fill_sentences_after_gate,
    gap_fill_claims_added,
    gap_fill_survivors,
    gap_fill_gate_details,
    s2_reverted,
    s2_revert_reason,
    response_sent_to_judge,
    v3_rewrite,
    judge_original:              { factuality: origFact, eligibility: origElig },
    judge_rewritten:             { factuality: rewFact,  eligibility: rewElig  },
    judge_panel_original:        origPanel,
    judge_panel_rewritten:       rewPanel,
    flip,
    damaged,
    effective_original,
    effective_rewritten,
    ts,
  };

  if (runId && runsDir) {
    const paths = persistRecord({
      runsDir, runId, record,
      meta: {
        run_id: runId, model,
        primary_threshold, gap_fill_trigger_threshold,
        gate_c1_enabled, gate_c2_enabled, gate_c3_enabled,
        extractor_model: process.env.EXTRACTOR_MODEL || 'claude-sonnet-4-6',
        judge_model:     process.env.JUDGE_MODEL     || 'gpt-5',
        started_at: ts,
      },
    });
    stage('STEP 7 · RECORD', `appended → ${path.relative(process.cwd(), paths.jsonl)}`);
  }

  return record;
}

module.exports = { runExample, generateBaseline, persistRecord };
