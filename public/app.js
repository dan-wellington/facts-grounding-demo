// Tularni · FACTS v5 dashboard. Vanilla JS, no build. State is held in two
// in-memory maps: `state.rows` (per example_id row data, populated from the
// SSE stream as the run progresses) and `state.full` (the full per-example
// records, lazy-loaded from /api/runs/:run_id when the user opens the drawer
// or switches to a historical run). All DOM mutation is funnelled through
// render*() functions so the table reflects state on every event.

const $ = sel => document.querySelector(sel);

// ─────── State ───────
const state = {
  tab:           'run',
  health:        null,
  examples:      [],          // { id, user_request, context_word_count }
  exById:        new Map(),
  pickMode:      'n',
  gate:          'TTT',
  cancelHandle:  null,        // AbortController for in-flight run
  runId:         null,
  rows:          new Map(),   // example_id → row data
  rowOrder:      [],          // example_id order, in submission order
  full:          new Map(),   // example_id → full record (from /api/runs/:id)
  selectedId:    null,
};

// ─────── Boot ───────
async function boot() {
  bindTabs();
  bindForm();
  bindDrawer();
  await loadHealth();
  await loadExamples();
}

// ─────── Health ───────
async function loadHealth() {
  try {
    const r = await fetch('/api/health'); const j = await r.json();
    state.health = j;
    const dot = $('#status-dot'), txt = $('#status-text');
    if (j.keys_missing?.length) {
      dot.className = 'dot bad';
      txt.textContent = 'KEYS MISSING: ' + j.keys_missing.join(', ');
    } else {
      dot.className = 'dot ok';
      txt.textContent = `READY · ${j.examples} examples`;
    }
  } catch (e) {
    $('#status-dot').className = 'dot bad';
    $('#status-text').textContent = 'API UNREACHABLE';
  }
}

// ─────── Examples (id picker source) ───────
async function loadExamples() {
  try {
    const r = await fetch('/api/examples'); const j = await r.json();
    state.examples = j.examples || [];
    state.exById = new Map(state.examples.map(e => [e.id, e]));
    const max = Math.max(1, state.examples.length);
    const nRange = $('#cfg-n'), nNum = $('#cfg-n-num');
    nRange.max = String(max);
    nNum.max   = String(max);
    if (+nRange.value > max) nRange.value = String(max);
    nNum.value = nRange.value;
    $('#lbl-n').textContent = nRange.value;
  } catch { /* status pill already shows badness */ }
}

// ─────── Tabs ───────
function bindTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
}
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + tab).classList.remove('hidden');
  if (tab === 'history') loadHistory();
}

// ─────── Form bindings ───────
function bindForm() {
  // Live-updating value labels for sliders
  const live = (input, label, fmt = v => v) => {
    const el = $(input), lbl = $(label);
    el.addEventListener('input', () => lbl.textContent = fmt(el.value));
  };
  live('#cfg-pt',  '#lbl-pt');
  live('#cfg-gft', '#lbl-gft', v => (+v).toFixed(2));
  live('#cfg-rc',  '#lbl-rc',  v => (+v).toFixed(2));
  live('#cfg-mcr', '#lbl-mcr');

  // n_examples — slider and number input mirror each other; both clamp to
  // the slider's current max (set by loadExamples once the corpus is known).
  const nRange = $('#cfg-n'), nNum = $('#cfg-n-num'), nLbl = $('#lbl-n');
  const syncN = (src) => {
    const max = +nRange.max || 1;
    let v = parseInt(src.value, 10);
    if (!Number.isFinite(v)) v = 1;
    v = Math.min(Math.max(v, 1), max);
    nRange.value = String(v);
    nNum.value   = String(v);
    nLbl.textContent = String(v);
  };
  nRange.addEventListener('input', () => syncN(nRange));
  nNum.addEventListener('input',   () => syncN(nNum));
  nNum.addEventListener('blur',    () => syncN(nNum));

  // Gate segmented control
  document.querySelectorAll('#cfg-gate .seg-opt').forEach(b => {
    b.onclick = () => {
      state.gate = b.dataset.gate;
      document.querySelectorAll('#cfg-gate .seg-opt').forEach(x => x.classList.toggle('active', x === b));
    };
  });

  // Pick mode
  document.querySelectorAll('#cfg-pick-mode .seg-opt').forEach(b => {
    b.onclick = () => {
      state.pickMode = b.dataset.pick;
      document.querySelectorAll('#cfg-pick-mode .seg-opt').forEach(x => x.classList.toggle('active', x === b));
      $('#field-n').classList.toggle('hidden',    state.pickMode !== 'n');
      $('#field-seed').classList.toggle('hidden', state.pickMode !== 'n');
      $('#field-ids').classList.toggle('hidden',  state.pickMode !== 'ids');
    };
  });

  // ID input feedback
  $('#cfg-ids').addEventListener('input', validateIds);

  // Revert toggle hides downstream params
  $('#cfg-revert').addEventListener('change', () => {
    $('#revert-row').classList.toggle('hidden', !$('#cfg-revert').checked);
  });

  $('#btn-run').onclick = startRun;
  $('#btn-cancel').onclick = cancelRun;
}

function validateIds() {
  const raw = $('#cfg-ids').value.trim();
  if (!raw) { $('#ids-feedback').textContent = ''; return null; }
  const ids = raw.split(/[\s,]+/).filter(Boolean).map(s => +s);
  const bad = ids.filter(n => !Number.isFinite(n));
  const miss = ids.filter(n => Number.isFinite(n) && !state.exById.has(n));
  const fb = $('#ids-feedback');
  if (bad.length)  { fb.textContent = `non-numeric: ${bad.join(', ')}`; fb.style.color = 'var(--red)';   return null; }
  if (miss.length) { fb.textContent = `not in corpus: ${miss.join(', ')}`; fb.style.color = 'var(--red)'; return null; }
  fb.textContent = `${ids.length} valid id${ids.length === 1 ? '' : 's'}`;
  fb.style.color = 'var(--green)';
  return ids;
}

// ─────── Build run config from form ───────
function buildConfig() {
  const gate = state.gate;
  const cfg = {
    model:                       $('#cfg-model').value,
    primary_threshold:           +$('#cfg-pt').value,
    gap_fill_trigger_threshold:  +$('#cfg-gft').value,
    revert_layer_enabled:        $('#cfg-revert').checked,
    reversion_knob:              +$('#cfg-rc').value,
    surgical_rewrite_enabled:    $('#cfg-surgical').checked,
    gap_fill_abstain_on_format:  $('#cfg-abstain').checked,
    max_changes_for_reversion:   +$('#cfg-mcr').value,
    max_concurrent:              +$('#cfg-mc').value,
    gate_c1_enabled:             gate[0] === 'T',
    gate_c2_enabled:             gate[1] === 'T',
    gate_c3_enabled:             gate[2] === 'T',
  };
  if (state.pickMode === 'ids') {
    const ids = validateIds();
    if (!ids) throw new Error('fix invalid example_ids first');
    if (!ids.length) throw new Error('enter at least one example_id');
    cfg.example_ids = ids;
  } else {
    cfg.n_examples = +$('#cfg-n').value;
    const seedRaw = $('#cfg-seed').value.trim();
    if (seedRaw !== '') {
      const seed = parseInt(seedRaw, 10);
      if (!Number.isFinite(seed) || seed < 0) throw new Error('seed must be a non-negative integer');
      cfg.seed = seed;
    }
  }
  return cfg;
}

// ─────── Long-form guard ───────
function selectedExamples(cfg) {
  if (cfg.example_ids) return cfg.example_ids.map(id => state.exById.get(id)).filter(Boolean);
  return state.examples.slice(0, cfg.n_examples);
}
function showModal(title, bodyHtml) {
  return new Promise(resolve => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal').classList.remove('hidden');
    $('#modal-cancel').onclick = () => { $('#modal').classList.add('hidden'); resolve(false); };
    $('#modal-confirm').onclick = () => { $('#modal').classList.add('hidden'); resolve(true);  };
  });
}

// ─────── Start a run ───────
async function startRun() {
  let cfg;
  try { cfg = buildConfig(); }
  catch (e) { alert(e.message); return; }

  // Long-form guard rail (>=1000 words burns a lot of credit)
  const longs = selectedExamples(cfg).filter(e => (e.context_word_count || 0) >= 1000);
  if (longs.length) {
    const ok = await showModal('LONG-FORM EXAMPLES IN BATCH', `
      <p><b>${longs.length}</b> selected example${longs.length === 1 ? '' : 's'} ${longs.length === 1 ? 'is' : 'are'} long-form
      (context_word_count ≥ 1000). These can burn substantial API credit per id.</p>
      <p>ids: <code>${longs.map(e => e.id).join(', ')}</code></p>
      <p>Proceed?</p>
    `);
    if (!ok) return;
  }

  // Reset live state
  state.runId   = null;
  state.rows.clear();
  state.rowOrder = [];
  state.full.clear();
  renderRunMeta(null);
  renderHeadline();
  renderTable();
  closeDrawer();

  // Show STOP, lock START
  $('#btn-run').disabled = true;
  $('#btn-cancel').classList.remove('hidden');
  $('#status-dot').className = 'dot run';
  $('#status-text').textContent = 'RUNNING…';

  state.cancelHandle = new AbortController();
  try {
    const resp = await fetch('/api/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(cfg),
      signal:  state.cancelHandle.signal,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${err.slice(0, 200)}`);
    }
    await consumeSSE(resp.body);
  } catch (e) {
    if (e.name === 'AbortError') {
      $('#status-text').textContent = 'STOPPED';
    } else {
      $('#status-text').textContent = 'ERROR: ' + e.message.slice(0, 60);
      $('#status-dot').className = 'dot bad';
    }
  } finally {
    $('#btn-run').disabled = false;
    $('#btn-cancel').classList.add('hidden');
    if ($('#status-dot').className.includes('run')) $('#status-dot').className = 'dot ok';
  }
}

function cancelRun() {
  if (state.cancelHandle) state.cancelHandle.abort();
}

// ─────── SSE consumer (POST + ReadableStream — EventSource doesn't do POST) ───────
async function consumeSSE(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleSSEBlock(block);
    }
  }
}

function handleSSEBlock(block) {
  let event = 'message', data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
    // skip ":" comments (heartbeats)
  }
  if (!data) return;
  let payload;
  try { payload = JSON.parse(data); } catch { return; }
  onSSE(event, payload);
}

function onSSE(event, p) {
  if (event === 'start') {
    state.runId = p.run_id;
    renderRunMeta(p);
    return;
  }
  if (event === 'begin') {
    if (!state.rows.has(p.example_id)) state.rowOrder.push(p.example_id);
    state.rows.set(p.example_id, {
      example_id:  p.example_id,
      words:       p.context_word_count,
      user_request: p.user_request,
      status:      'running',
    });
    renderTable();
    renderWorkers();
    return;
  }
  if (event === 'progress') {
    state.rows.set(p.example_id, {
      ...state.rows.get(p.example_id),
      ...p,
      status: 'done',
    });
    renderHeadline();
    renderTable();
    renderWorkers();
    return;
  }
  if (event === 'error') {
    state.rows.set(p.example_id, {
      ...state.rows.get(p.example_id),
      status: 'error',
      error:  p.error,
    });
    renderTable();
    renderWorkers();
    return;
  }
  if (event === 'done') {
    $('#status-text').textContent =
      `DONE · ${p.completed} ok` + (p.failed ? ` · ${p.failed} failed` : '') +
      ` · ${p.wall_clock_s}s`;
    $('#status-dot').className = p.failed ? 'dot bad' : 'dot ok';
    renderWorkers();
    return;
  }
}

// ─────── Render: run meta strip ───────
function renderRunMeta(start) {
  const el = $('#run-meta');
  if (!start) {
    el.innerHTML = '<span class="run-meta-empty">No run yet. Configure on the left and hit START RUN.</span>';
    return;
  }
  el.innerHTML = `<span>run · <b>${start.run_id}</b></span>`;
}

// ─────── Render: headline metrics ───────
function renderHeadline() {
  const rows = [...state.rows.values()].filter(r => r.status === 'done');
  if (!rows.length) {
    ['m-baseline','m-rewrite','m-flips','m-damaged','m-reverts'].forEach(id => $('#'+id).textContent = '—');
    return;
  }
  const baselinePass = rows.filter(r => r.effective_original).length;
  const rewritePass  = rows.filter(r => r.effective_rewritten).length;
  const flips        = rows.filter(r => r.flip).length;
  const damaged      = rows.filter(r => r.damaged).length;
  const reverts      = rows.filter(r => r.s1_reverted || r.s2_reverted).length;
  const tot = rows.length;
  $('#m-baseline').textContent = `${baselinePass}/${tot}`;
  $('#m-rewrite').textContent  = `${rewritePass}/${tot}`;
  $('#m-flips').textContent    = String(flips);
  $('#m-damaged').textContent  = String(damaged);
  $('#m-reverts').textContent  = String(reverts);
}

// ─────── Render: per-row table ───────
// ─────── Render: corner cluster of active workers ───────
// One bouncing ball per example currently in the 'running' state. Each ball
// gets a small stagger so the row doesn't bounce in lockstep.
function renderWorkers() {
  const corner = $('#workers-corner');
  const active = [...state.rows.values()].filter(r => r.status === 'running');
  // Keep just the label; rebuild the balls fresh each render (cheap).
  corner.innerHTML = '<span class="workers-corner-label">ACTIVE · ' + active.length + '</span>';
  active.forEach((r, i) => {
    const stage = document.createElement('span');
    stage.className = 'ball-stage';
    stage.title = `id ${r.example_id}`;
    const ball = document.createElement('span');
    ball.className = 'ball';
    // Stagger so 5 balls don't bounce in unison.
    ball.style.animationDelay = (i * 0.12) + 's';
    stage.appendChild(ball);
    corner.appendChild(stage);
  });
  corner.classList.toggle('active', active.length > 0);
}

function renderTable() {
  const tbody = $('#results-body');
  if (!state.rowOrder.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="10">— no rows yet —</td></tr>';
    return;
  }
  const html = state.rowOrder.map(id => {
    const r = state.rows.get(id);
    if (!r) return '';
    if (r.status === 'running') {
      return `<tr class="row-running" data-id="${id}">
        <td class="id">${id}</td>
        <td>${r.words ?? '—'}</td>
        <td class="req">${escapeHtml(r.user_request || '')}</td>
        <td colspan="7"><span class="ball-stage"><span class="ball"></span></span></td>
      </tr>`;
    }
    if (r.status === 'error') {
      return `<tr class="row-error" data-id="${id}">
        <td class="id">${id}</td>
        <td>${r.words ?? '—'}</td>
        <td class="req">${escapeHtml(r.user_request || '')}</td>
        <td colspan="7">ERROR · ${escapeHtml(r.error || '')}</td>
      </tr>`;
    }
    // "Reverted" column. Yes whenever v3_rewrite is bit-identical to the
    // baseline (covers s1/s2 revert, min_changes skip, 0-flagged trivial case,
    // and any other path where the architecture didn't touch the response).
    const rev = (r.s1_reverted || r.s2_reverted || r.rewrite_is_baseline) ? 'Yes' : '—';
    const baseline = r.effective_original  ? 'pass' : 'fail';
    const rewrite  = r.effective_rewritten ? 'pass' : 'fail';
    let outcome = 'same', outcomeCls = 'same';
    if (r.flip)         { outcome = 'FLIP+';   outcomeCls = 'flip'; }
    else if (r.damaged) { outcome = 'DAMAGED'; outcomeCls = 'dam'; }
    else if (r.s1_reverted || r.s2_reverted) { outcome = 'REVERT'; outcomeCls = 'rev'; }
    return `<tr data-id="${id}" class="${state.selectedId === id ? 'selected' : ''}">
      <td class="id">${id}</td>
      <td>${r.words ?? '—'}</td>
      <td class="req">${escapeHtml(r.user_request || '')}</td>
      <td class="num">${r.n_claims ?? '—'}</td>
      <td class="num">${r.n_flagged ?? '—'}</td>
      <td class="num">${gapClaims(r)}</td>
      <td>${rev}</td>
      <td><span class="verdict ${baseline}">${baseline.toUpperCase()}</span></td>
      <td><span class="verdict ${rewrite}">${rewrite.toUpperCase()}</span></td>
      <td><span class="verdict ${outcomeCls}">${outcome}</span></td>
    </tr>`;
  }).join('');
  tbody.innerHTML = html;
  // Bind row clicks
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.onclick = () => openDrawer(+tr.dataset.id);
  });
}

// Atomic gap-fill claims that ended up in the final rewrite. New records
// persist this aggregate directly; older records (pre-v6.1) get a derived
// value from gap_fill_gate_details if available.
function gapClaims(r) {
  if (typeof r.gap_fill_claims_added === 'number') return r.gap_fill_claims_added;
  if (Array.isArray(r.gap_fill_gate_details)) {
    return r.gap_fill_gate_details
      .filter(d => d.kept)
      .reduce((s, d) => s + (d.n_claims || 0), 0);
  }
  return 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

// ─────── Drawer (per-example detail) ───────
function bindDrawer() {
  $('#drw-close').onclick = closeDrawer;
}
function closeDrawer() {
  $('#drawer').classList.add('hidden');
  state.selectedId = null;
  document.querySelectorAll('.results tr.selected').forEach(tr => tr.classList.remove('selected'));
}

async function openDrawer(exampleId) {
  state.selectedId = exampleId;
  document.querySelectorAll('.results tr').forEach(tr =>
    tr.classList.toggle('selected', +tr.dataset.id === exampleId));
  const drw = $('#drawer');
  drw.classList.remove('hidden');
  $('#drw-id').textContent = `EXAMPLE ${exampleId}`;
  $('#drw-sub').textContent = 'loading record…';
  $('#drw-body').innerHTML = '';

  // Fetch full record from results.jsonl (the SSE progress payload doesn't
  // include claims, panel breakdown, or the rewrite text).
  let rec = state.full.get(exampleId);
  if (!rec && state.runId) {
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(state.runId)}`);
      const j = await r.json();
      (j.records || []).forEach(rec => state.full.set(rec.example_id, rec));
      rec = state.full.get(exampleId);
    } catch { /* show partial */ }
  }
  if (!rec) {
    rec = state.rows.get(exampleId) || {};
  }
  renderDrawer(rec);
}

function renderDrawer(rec) {
  const ex = state.exById.get(rec.example_id) || {};
  $('#drw-sub').textContent = `${ex.context_word_count ?? rec.n_words ?? '?'} words · ${ex.user_request ? ex.user_request.slice(0, 90) + (ex.user_request.length > 90 ? '…' : '') : ''}`;

  const sec = (title, body) => `<div class="section"><h4>${title}</h4>${body}</div>`;

  // Pipeline summary
  const pipeline = `<dl class="kv">
    <dt>n_claims</dt><dd>${rec.n_claims ?? '—'}</dd>
    <dt>n_flagged</dt><dd>${rec.n_flagged ?? '—'}</dd>
    <dt>n_sentences</dt><dd>${rec.n_sentences_kept ?? '—'} kept · ${rec.n_sentences_dropped ?? '—'} dropped (${rec.drop_ratio != null ? rec.drop_ratio.toFixed(3) : '—'})</dd>
    <dt>revert</dt><dd>${
      rec.s1_reverted ? 's1 (' + rec.s1_revert_reason + ')' :
      rec.s2_reverted ? 's2 (' + rec.s2_revert_reason + ')' :
      (rec.surgical_skipped && rec.surgical_skip_reason && rec.surgical_skip_reason.includes('max_changes_for_reversion'))
        ? 'skip · ' + rec.surgical_skip_reason :
      '—'
    }</dd>
    <dt>gap-fill</dt><dd>${rec.gap_fill_triggered ? `triggered · proposed ${rec.gap_fill_sentences_proposed} → after_gate ${rec.gap_fill_sentences_after_gate}` : 'bypass'}</dd>
    <dt>sent to judge</dt><dd>${rec.response_sent_to_judge ?? '—'}</dd>
  </dl>`;

  // Texts
  const baseline = rec.original_response || '(not loaded — may need history view)';
  const rewrite  = rec.v3_rewrite        || '(not loaded)';
  const texts = `
    <div class="text-block diff-old"><b style="color:var(--red);font-weight:500;">BASELINE</b>\n${escapeHtml(baseline)}</div>
    <div style="height:8px"></div>
    <div class="text-block diff-new"><b style="color:var(--green);font-weight:500;">REWRITE (sent to judge)</b>\n${escapeHtml(rewrite)}</div>`;

  // Per-claim gate trace
  let claims = '';
  if (Array.isArray(rec.claims) && rec.claims.length) {
    claims = rec.claims.map(c => {
      const cls = c.flagged ? 'flagged' : 'passed';
      const stage = (label, v) => v ? `<span class="claim-stage ${v.confidence >= 80 ? 'high' : (v.confidence < 50 ? 'low' : '')}"><b>${label}</b> ${v.confidence}</span>` : '';
      // v6.4: gate stages emit confidence-only by default. Older runs (or
      // explicitly-verbose runs) still carry per-stage reasoning; render it
      // when present, otherwise omit the block entirely so the row stays tight.
      const reasoning = ['c1','c2','c3']
        .filter(k => c[k] && c[k].reasoning && c[k].reasoning !== '(parse failed)')
        .map(k => `<div><b>${k}:</b> ${escapeHtml(c[k].reasoning)}</div>`)
        .join('');
      return `<div class="claim ${cls}">
        <div class="claim-text">${escapeHtml(c.text || '')}</div>
        <div class="claim-stages">${stage('c1', c.c1)}${stage('c2', c.c2)}${stage('c3', c.c3)}<span style="margin-left:auto;color:var(--ink-dim)">${c.flagged ? 'FLAGGED' : 'pass'}</span></div>
        <div class="claim-reasoning">${reasoning}</div>
      </div>`;
    }).join('');
  } else {
    claims = '<div class="text-block dim">— claim trace not loaded —</div>';
  }

  // Gap-fill survivors. v6.3+ stores them as {text, gap_id} objects;
  // earlier runs stored bare strings. Render both forms.
  let gapfill = '';
  if (rec.gap_fill_triggered) {
    const survivors = (rec.gap_fill_survivors || []).map(s => {
      const text   = typeof s === 'string' ? s : (s.text || '');
      const tag    = (s && typeof s === 'object' && s.gap_id != null) ? ` <span class="hint">gap ${s.gap_id}</span>` : '';
      return `<div class="claim passed"><div class="claim-text">${escapeHtml(text)}${tag}</div></div>`;
    }).join('');
    const gaps = (rec.gaps_identified || []).map(g => `<div class="claim"><div class="claim-text"><b>gap ${g.id}:</b> ${escapeHtml(g.description)}</div><div class="claim-reasoning"><b>evidence:</b> ${escapeHtml(g.context_evidence || '')}</div></div>`).join('');
    gapfill = `${gaps || '<span class="hint">no gaps</span>'}<div style="height:8px"></div><div class="hint">SURVIVORS (${rec.gap_fill_sentences_after_gate})</div>${survivors}`;
  }

  // Panel verdicts
  const judgeBlock = (panel, label) => {
    if (!panel) return '';
    const cell = (id) => {
      const j = panel[id];
      if (!j) return '';
      const cls = j.verdict === 'Eligible' ? 'elig' : 'inel';
      return `<div class="judge"><div class="judge-name">${id.replace(/_/g,' ')}</div><div class="judge-verdict ${cls}">${j.verdict}</div><div class="hint" style="margin-top:6px">${escapeHtml((j.reasoning || '').slice(0, 200))}</div></div>`;
    };
    return `<div style="margin-bottom:6px;font-size:11px;color:var(--ink-soft);letter-spacing:.05em">${label} · panel verdict: <b style="color:${panel.eligibility_verdict==='Eligible'?'var(--green)':'var(--red)'}">${panel.eligibility_verdict}</b></div><div class="judges">${cell('gemini_2_5_pro')}${cell('gpt_5')}${cell('claude_sonnet_4_6')}</div>`;
  };
  let panels = '';
  if (rec.judge_panel_original || rec.judge_panel_rewritten) {
    panels = (judgeBlock(rec.judge_panel_original, 'BASELINE') || '') +
             '<div style="height:10px"></div>' +
             (judgeBlock(rec.judge_panel_rewritten, 'REWRITE') || '');
  } else {
    panels = '<div class="text-block dim">— panel breakdown not loaded —</div>';
  }

  // Factuality. Click the row to expand full reasoning (uses native <details>).
  const fact = (j, label) => {
    if (!j) return '';
    const verdict   = j.factuality?.verdict || '—';
    const reasoning = j.factuality?.reasoning || '';
    if (!reasoning) {
      return `<div class="judge-fact-row"><b style="color:var(--ink-soft)">${label}</b> · ${verdict}</div>`;
    }
    return `<details class="judge-fact-row">
      <summary><b style="color:var(--ink-soft)">${label}</b> · ${verdict} · <span class="hint">${escapeHtml(reasoning.slice(0, 160))}${reasoning.length > 160 ? '…' : ''}</span></summary>
      <div class="judge-fact-full">${escapeHtml(reasoning)}</div>
    </details>`;
  };
  const factuality = (rec.judge_original || rec.judge_rewritten)
    ? fact(rec.judge_original, 'baseline') + fact(rec.judge_rewritten, 'rewrite')
    : '<div class="text-block dim">— factuality not loaded —</div>';

  $('#drw-body').innerHTML =
    sec('PIPELINE', pipeline) +
    sec('RESPONSE TEXT', texts) +
    sec('CLAIM-LEVEL GATE TRACE', claims) +
    (rec.gap_fill_triggered ? sec('GAP-FILL', gapfill) : '') +
    sec('FACTUALITY JUDGE', factuality) +
    sec('ELIGIBILITY PANEL', panels);
}

// ─────── History ───────
async function loadHistory() {
  const list = $('#history-list');
  list.innerHTML = '<span class="hint">loading…</span>';
  try {
    const r = await fetch('/api/runs'); const j = await r.json();
    if (!j.runs?.length) {
      list.innerHTML = '<span class="hint">no past runs found</span>';
      return;
    }
    list.innerHTML = j.runs.map(run => {
      const m = run.meta || {};
      const s = run.summary || {};
      return `<div class="history-row" data-id="${run.run_id}">
        <div class="h-id">${run.run_id}</div>
        <div class="h-meta">${m.model || '?'}</div>
        <div class="h-meta">${run.mtime ? run.mtime.replace('T',' ').slice(0,16) : ''}</div>
        <div class="h-stats">
          <span class="h-stat"><b>${s.n_records}</b> recs</span>
          <span class="h-stat"><b>${s.baseline_pass}</b>/<b>${s.rewrite_pass}</b> pass</span>
          <span class="h-stat" style="color:var(--green)"><b>${s.flips}</b> flips</span>
          <span class="h-stat" style="color:var(--red)"><b>${s.damaged}</b> damaged</span>
        </div>
        <button class="btn-ghost" style="margin:0;width:auto;padding:6px 14px">OPEN</button>
      </div>`;
    }).join('');
    list.querySelectorAll('.history-row').forEach(row => {
      row.onclick = () => openHistoricalRun(row.dataset.id);
    });
  } catch (e) {
    list.innerHTML = `<span class="hint" style="color:var(--red)">failed to load: ${e.message}</span>`;
  }
}

async function openHistoricalRun(runId) {
  switchTab('run');
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  const j = await r.json();
  state.runId = runId;
  state.rows.clear();
  state.rowOrder = [];
  state.full.clear();
  for (const rec of (j.records || [])) {
    const ex = state.exById.get(rec.example_id) || {};
    state.rowOrder.push(rec.example_id);
    state.rows.set(rec.example_id, {
      ...rec,
      status:       'done',
      words:        ex.context_word_count,
      user_request: ex.user_request,
    });
    state.full.set(rec.example_id, rec);
  }
  renderRunMeta(j.meta ? { ...j.meta, run_id: runId } : null);
  renderHeadline();
  renderTable();
  $('#status-text').textContent = `LOADED · ${runId}`;
  $('#status-dot').className = 'dot ok';
}

// ─────── Boot ───────
boot();
