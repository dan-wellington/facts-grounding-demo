// Tularni FACTS Grounding demo · v5 — stage-toggling gate + claim-level drop.
// Single batch endpoint with SSE progress + per-example JSONL persistence.
// v5 = v4 architecture (claim-level drop, gap-fill, revert, panel judges) with
// the gate stages individually toggleable via gate_c{1,2,3}_enabled. Allowed
// configs: TTT (full), TTF (no confront), FTT (no parametric), FTF (grounded
// only). Defaults to TTT, which reproduces v4 behavior exactly.

require('dotenv').config();

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const { runExample } = require('./lib/pipeline');
const { providerFor } = require('./lib/architectureClient');

// mulberry32 — tiny deterministic PRNG. Used by the seeded n_examples picker.
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── runs/ scaffold ───────────────────────────────────────────────────────────
const RUNS_DIR = path.join(__dirname, 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

// ── FACTS corpus load + filter ───────────────────────────────────────────────
// CONTEXT_FILTER selects which slice of the corpus to expose:
//   'lt1000' (default) → context_word_count < 1000   (back-compat)
//   'ge1000'           → context_word_count >= 1000  (long-context subset)
//   'all'              → no filter
const FACTS_PATH    = path.join(__dirname, 'facts_grounding_public.json');
const CONTEXT_FILTER = (process.env.CONTEXT_FILTER || 'lt1000').toLowerCase();
let examples = [];
try {
  const raw = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));
  const all = Array.isArray(raw) ? raw : (raw.examples ?? raw.data ?? []);
  let label;
  if (CONTEXT_FILTER === 'ge1000') {
    examples = all.filter(e => (e.context_word_count ?? 0) >= 1000);
    label = '>=1000 words';
  } else if (CONTEXT_FILTER === 'all') {
    examples = all.slice();
    label = 'no filter';
  } else {
    examples = all.filter(e => (e.context_word_count ?? Infinity) < 1000);
    label = '<1000 words';
  }
  console.log(`[FACTS] ${all.length} examples in source · ${examples.length} kept after filter (${label})`);
} catch (err) {
  console.error(`[FACTS] failed to load ${FACTS_PATH}: ${err.message}`);
  console.error('       symlink the corpus: ln -s ../facts_grounding_public.json .');
}

// ── env audit (non-fatal — keys are only required at run time) ───────────────
const REQUIRED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'JUDGE_MODEL', 'EXTRACTOR_MODEL'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) console.warn(`[env] missing: ${missing.join(', ')} (set them before /api/run)`);
console.log(`[env] judge=${process.env.JUDGE_MODEL || '—'} · extractor=${process.env.EXTRACTOR_MODEL || '—'}`);

// ── health probe ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    ok:           true,
    version:      'v4 claim-level drop + gap-fill',
    examples:     examples.length,
    runs_dir:     path.relative(__dirname, RUNS_DIR),
    judge_model:  process.env.JUDGE_MODEL || null,
    extractor:    process.env.EXTRACTOR_MODEL || null,
    keys_loaded:  REQUIRED.filter(k => !!process.env[k]),
    keys_missing: missing,
  });
});

// ── /api/examples — id picker source for the UI ─────────────────────────────
// Returns id, user_request, context_word_count for every example surviving the
// configured CONTEXT_FILTER. The UI uses this to populate the per-id picker
// and to drive the long-form (>=1000 words) confirmation gate.
app.get('/api/examples', (_req, res) => {
  res.json({
    filter:   CONTEXT_FILTER,
    count:    examples.length,
    examples: examples.map(e => ({
      id:                 e.id,
      user_request:       e.user_request,
      context_word_count: e.context_word_count ?? 0,
    })),
  });
});

// ── /api/runs — list past run directories with meta + summary ───────────────
// Used by the HISTORY tab. Each entry is the parsed meta.json plus a derived
// summary from results.jsonl (n_records, completed, baseline_pass, rewrite_pass,
// flips, damaged). Cheap enough to compute on every request given the small
// number of runs typically present.
app.get('/api/runs', (_req, res) => {
  let dirs;
  try { dirs = fs.readdirSync(RUNS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); }
  catch { return res.json({ runs: [] }); }

  const runs = dirs.map(d => {
    const dir       = path.join(RUNS_DIR, d.name);
    const metaPath  = path.join(dir, 'meta.json');
    const jsonlPath = path.join(dir, 'results.jsonl');
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* missing meta */ }

    let summary = { n_records: 0, baseline_pass: 0, rewrite_pass: 0, flips: 0, damaged: 0, reverts: 0 };
    let mtime;
    try {
      const stat = fs.statSync(jsonlPath);
      mtime = stat.mtime.toISOString();
      const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
      summary.n_records = lines.length;
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (r.effective_original)  summary.baseline_pass++;
          if (r.effective_rewritten) summary.rewrite_pass++;
          if (r.flip)                summary.flips++;
          if (r.damaged)             summary.damaged++;
          if (r.s1_reverted || r.s2_reverted) summary.reverts++;
        } catch { /* skip bad line */ }
      }
    } catch { /* no jsonl yet */ }

    return { run_id: d.name, meta, summary, mtime };
  });

  // Newest first.
  runs.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  res.json({ runs });
});

// ── /api/runs/:run_id — full meta + every record from results.jsonl ─────────
// Used by the HISTORY tab when a run is opened, and (optionally) by the live
// view to backfill records the SSE drawer needs (per-claim gate trace, panel
// per-judge verdicts) that aren't present in the lightweight progress event.
app.get('/api/runs/:run_id', (req, res) => {
  const runId = req.params.run_id;
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) return res.status(400).json({ error: 'invalid run_id' });
  const dir = path.join(RUNS_DIR, runId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'run not found' });

  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); }
  catch { /* missing meta */ }

  let records = [];
  try {
    const lines = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean);
    records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no jsonl */ }

  res.json({ run_id: runId, meta, records });
});

// ── /api/run — batch with SSE progress + JSONL persistence ───────────────────
// Body: { model, primary_threshold, gate_c{1,2,3}_enabled, n_examples, run_id?, example_ids? }
// SSE events:
//   start    — { run_id, model, primary_threshold, gate_c1/c2/c3_enabled, n_examples, example_ids, ... }
//   begin    — { i, n, example_id, user_request, context_word_count }
//   progress — { i, n, example_id, n_claims, n_flagged, n_sentences_*, judge verdicts, flip, damaged, effective_* }
//   error    — { i, example_id, error }
//   done     — { run_id, completed, failed, finished_at }
app.post('/api/run', async (req, res) => {
  const body = req.body || {};
  const model         = String(body.model || 'claude-sonnet-4-6');
  const primaryT      = Number.isFinite(body.primary_threshold)           ? +body.primary_threshold           : 50;
  const gapT          = Number.isFinite(body.gap_fill_trigger_threshold)  ? +body.gap_fill_trigger_threshold  : 0.40;
  const revertEnabled = body.revert_layer_enabled === true;
  // v6: single revert knob. revert_ratio + revert_surv_threshold removed.
  // v6.7: reversion_knob replaces revert_drop_ceiling. Semantic flip:
  // higher knob = more reverts (intuitive). Internally we revert when
  // flag_ratio > (1 - reversion_knob); equivalent to old ceiling = 1 - knob.
  const reversionKnob = Number.isFinite(body.reversion_knob) ? +body.reversion_knob : 0.30;
  // v6.2: surgical rewrite default ON. Set explicitly to false to use the
  // legacy v4 claim-level concat (atomic-claim re-emission, fragmenting).
  const surgicalEnabled = body.surgical_rewrite_enabled === false ? false : true;
  // v6.5: gap-fill format-constraint abstain. Default ON — when the baseline
  // is in a tight format (1-2 bullets or <30 words), gap-fill is skipped to
  // preserve the user's implied format.
  const abstainOnFormat = body.gap_fill_abstain_on_format === false ? false : true;
  // v6.6: skip surgical when n_flagged is at or below this threshold. Default
  // 2 — small flag counts trip the judge as "the rewrite differs from baseline"
  // even when content is intact, so we ship pristine for tiny-edit cases.
  // v6.7: max_changes_for_reversion (renamed from min_changes_for_rewrite,
  // same semantics): n_flagged ≤ this number triggers ship-baseline path.
  const maxChangesForReversion = Number.isInteger(body.max_changes_for_reversion) && body.max_changes_for_reversion >= 0
    ? body.max_changes_for_reversion : 1;
  const reqMaxConc    = Number.isInteger(body.max_concurrent) && body.max_concurrent > 0 ? body.max_concurrent : null;
  const nExamples     = Number.isInteger(body.n_examples) ? body.n_examples : 1;
  const runId         = String(body.run_id || `batch-${Date.now()}`);
  const exampleIds    = Array.isArray(body.example_ids) ? body.example_ids : null;
  // Optional integer seed for the first-N picker. When set, deterministically
  // shuffles the corpus before slicing, so the same seed + n_examples always
  // returns the same set of ids regardless of what other runs have done.
  // Ignored when example_ids is provided (the user picked specific ids).
  const seed          = Number.isInteger(body.seed) ? body.seed : null;
  // v5: gate stage toggles. Default TTT (full v4 behavior). Allowed: TTT, TTF,
  // FTT, FTF — gate_c2_enabled must be true.
  const gateC1 = body.gate_c1_enabled === undefined ? true : body.gate_c1_enabled === true;
  const gateC2 = body.gate_c2_enabled === undefined ? true : body.gate_c2_enabled === true;
  const gateC3 = body.gate_c3_enabled === undefined ? true : body.gate_c3_enabled === true;

  if (!providerFor(model)) return res.status(400).json({
    error: `unknown model id: "${model}" (expected claude-*, gpt-*, or gemini-*)`,
  });
  if (primaryT  < 0 || primaryT  > 100) return res.status(400).json({ error: 'primary_threshold must be 0-100' });
  if (gapT      < 0 || gapT      > 1)   return res.status(400).json({ error: 'gap_fill_trigger_threshold must be 0-1' });
  if (reversionKnob < 0 || reversionKnob > 1) return res.status(400).json({ error: 'reversion_knob must be 0-1' });
  if ('revert_ratio' in body || 'revert_surv_threshold' in body || 'revert_drop_ceiling' in body) {
    return res.status(400).json({ error: 'revert_ratio / revert_surv_threshold / revert_drop_ceiling are no longer supported. Use reversion_knob (0-1, higher = more reverts) instead.' });
  }
  if ('min_changes_for_rewrite' in body) {
    return res.status(400).json({ error: 'min_changes_for_rewrite was renamed to max_changes_for_reversion (same semantics).' });
  }
  if (!gateC2) return res.status(400).json({
    error: 'gate_c2_enabled must be true. Allowed configs: TTT, TTF, FTT, FTF.',
  });
  if (!examples.length)                  return res.status(503).json({ error: 'corpus not loaded' });
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY)
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY / OPENAI_API_KEY required' });

  let picks;
  if (exampleIds) {
    const byId = new Map(examples.map(e => [e.id, e]));
    const miss = exampleIds.filter(id => !byId.has(id));
    if (miss.length) return res.status(400).json({ error: `example_ids not in corpus: ${miss.join(',')}` });
    picks = exampleIds.map(id => byId.get(id));
  } else {
    if (nExamples < 1 || nExamples > examples.length)
      return res.status(400).json({ error: `n_examples must be 1..${examples.length}` });
    if (seed != null) {
      // mulberry32 PRNG → Fisher–Yates shuffle. Same seed + same corpus =>
      // same id ordering, so a user can re-run an experiment and pull the
      // exact same N examples.
      const rng = mulberry32(seed >>> 0);
      const shuffled = examples.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      picks = shuffled.slice(0, nExamples);
    } else {
      picks = examples.slice(0, nExamples);
    }
  }

  const startedAt = new Date().toISOString();

  // Write meta.json upfront so the run is identifiable mid-stream.
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const metaPath = path.join(runDir, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(metaPath, JSON.stringify({
      run_id: runId,
      model,
      primary_threshold:          primaryT,
      gap_fill_trigger_threshold: gapT,
      revert_layer_enabled:       revertEnabled,
      reversion_knob:             reversionKnob,
      surgical_rewrite_enabled:   surgicalEnabled,
      gap_fill_abstain_on_format: abstainOnFormat,
      max_changes_for_reversion:  maxChangesForReversion,
      gate_c1_enabled:            gateC1,
      gate_c2_enabled:            gateC2,
      gate_c3_enabled:            gateC3,
      max_concurrent:             reqMaxConc ?? parseInt(process.env.MAX_CONCURRENT || '10', 10),
      n_examples:                 picks.length,
      seed:                       seed,
      example_ids:                picks.map(e => e.id),
      extractor_model:            process.env.EXTRACTOR_MODEL || 'claude-sonnet-4-6',
      judge_model:                process.env.JUDGE_MODEL     || 'gpt-5',
      started_at:                 startedAt,
    }, null, 2));
  }

  // SSE headers — disable proxy buffering, keep connection alive.
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat every 25s so reverse proxies don't drop the connection.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': ping\n\n');
  }, 25_000);

  send('start', {
    run_id: runId, model,
    primary_threshold:          primaryT,
    gap_fill_trigger_threshold: gapT,
    revert_layer_enabled:       revertEnabled,
    reversion_knob:             reversionKnob,
    surgical_rewrite_enabled:   surgicalEnabled,
    gap_fill_abstain_on_format: abstainOnFormat,
    max_changes_for_reversion:  maxChangesForReversion,
    gate_c1_enabled:            gateC1,
    gate_c2_enabled:            gateC2,
    gate_c3_enabled:            gateC3,
    max_concurrent:             reqMaxConc ?? parseInt(process.env.MAX_CONCURRENT || '10', 10),
    n_examples:                 picks.length,
    seed:                       seed,
    example_ids:                picks.map(e => e.id),
    extractor_model:            process.env.EXTRACTOR_MODEL || 'claude-sonnet-4-6',
    judge_model:                process.env.JUDGE_MODEL     || 'gpt-5',
    started_at:                 startedAt,
  });

  // ── Concurrent worker pool ────────────────────────────────────────────
  // Process examples in parallel with a semaphore-style cap. SSE events
  // (begin / progress / error) still fire per example; the `i` field on each
  // event is the original picks index so consumers can stitch ordering.
  // Append-to-results.jsonl is safe across workers because Node's
  // fs.appendFileSync is synchronous and serialised on the event loop.
  const MAX_CONCURRENT = Number.isInteger(body.max_concurrent) && body.max_concurrent > 0
    ? body.max_concurrent
    : parseInt(process.env.MAX_CONCURRENT || '10', 10);

  const wallStart = Date.now();
  let completed = 0, failed = 0;
  const erroredIds = [];

  const processOne = async (ex, i) => {
    const t0 = Date.now();
    send('begin', { i, n: picks.length, example_id: ex.id, user_request: ex.user_request, context_word_count: ex.context_word_count });
    try {
      const rec = await runExample({
        example: ex, model,
        primary_threshold:          primaryT,
        gap_fill_trigger_threshold: gapT,
        revert_layer_enabled:       revertEnabled,
        reversion_knob:             reversionKnob,
        surgical_rewrite_enabled:   surgicalEnabled,
        gap_fill_abstain_on_format: abstainOnFormat,
        max_changes_for_reversion:  maxChangesForReversion,
        gate_c1_enabled:            gateC1,
        gate_c2_enabled:            gateC2,
        gate_c3_enabled:            gateC3,
        runId, runsDir: RUNS_DIR,
        log: () => {},
      });
      completed++;
      send('progress', {
        i, n: picks.length,
        example_id:                    ex.id,
        n_claims:                      rec.n_claims,
        n_flagged:                     rec.n_flagged,
        flag_ratio:                    rec.flag_ratio,
        n_sentences_total:             rec.n_sentences_total,
        n_sentences_kept:              rec.n_sentences_kept,
        n_sentences_dropped:           rec.n_sentences_dropped,
        drop_ratio:                    rec.drop_ratio,
        gap_fill_triggered:            rec.gap_fill_triggered,
        gap_fill_sentences_proposed:   rec.gap_fill_sentences_proposed,
        gap_fill_sentences_after_cap:  rec.gap_fill_sentences_after_cap,
        gap_fill_sentences_after_gate: rec.gap_fill_sentences_after_gate,
        gap_fill_claims_added:         rec.gap_fill_claims_added,
        s1_reverted:                   rec.s1_reverted,
        s1_revert_reason:              rec.s1_revert_reason,
        s2_reverted:                   rec.s2_reverted,
        s2_revert_reason:              rec.s2_revert_reason,
        surgical_skipped:              rec.surgical_skipped,
        surgical_skip_reason:          rec.surgical_skip_reason,
        rewrite_is_baseline:           rec.original_response === rec.v3_rewrite,
        response_sent_to_judge:        rec.response_sent_to_judge,
        judge_original_factuality:     rec.judge_original.factuality.verdict,
        judge_original_eligibility:    rec.judge_original.eligibility.verdict,
        judge_rewritten_factuality:    rec.judge_rewritten.factuality.verdict,
        judge_rewritten_eligibility:   rec.judge_rewritten.eligibility.verdict,
        flip:                          rec.flip,
        damaged:                       rec.damaged,
        effective_original:            rec.effective_original,
        effective_rewritten:           rec.effective_rewritten,
        elapsed_ms:                    Date.now() - t0,
      });
    } catch (err) {
      failed++;
      erroredIds.push({ example_id: ex.id, error: err.message });
      console.error(`[/api/run] example ${ex.id} failed:`, err.message);
      send('error', { i, example_id: ex.id, error: err.message, elapsed_ms: Date.now() - t0 });
    }
  };

  // Worker pool — N workers each pulling from a shared queue cursor.
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= picks.length) break;
      await processOne(picks[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, picks.length) }, worker));

  clearInterval(heartbeat);
  const wallMs = Date.now() - wallStart;
  send('done', {
    run_id:        runId,
    completed,
    failed,
    errored_ids:   erroredIds,
    max_concurrent: MAX_CONCURRENT,
    wall_clock_ms: wallMs,
    wall_clock_s:  +(wallMs / 1000).toFixed(1),
    finished_at:   new Date().toISOString(),
  });
  res.end();
});

const PORT = parseInt(process.env.PORT || '3022', 10);
app.listen(PORT, () => console.log(`Tularni FACTS demo · v4 · http://localhost:${PORT}`));

module.exports = { app, examples, RUNS_DIR };
