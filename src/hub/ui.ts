/**
 * HostedHubUI (plan task 11) — HTML matching the approved design artifact.
 *
 * Two pages built from shared parts:
 * - control page (tablet, operator): full sidebar with setup, corrections
 *   grid (incl. UNDO / FOUL / CORRECT SCORE), manual adjustment form,
 *   calibration modal, status panel.
 * - /tv (read-only viewer, FR-10): scoreboard + camera + event log only, no
 *   controls (`tv-main-view`).
 *
 * All design-artifact test IDs are present (IR-1..6): notification-banner
 * (red, exclamation icon, "HUMAN INTERVENTION REQUIRED", `angry-blink`
 * animation), camera-feed-container / camera-feed-placeholder (16:9),
 * player-1-score / player-2-score with active indicator, current-break in
 * amber, rule-preset-select (Professional/Amateur/Club), calibrate-button,
 * calibration-modal + begin-calibration-button, current-frame, frame-info,
 * event-log, panel-corrections, correction-pot-missed,
 * apply-correction-button, confidence-slider, tv-main-view.
 */

const CSS = /* css */ `
  :root {
    --bg: #0d1117; --panel: #161b22; --edge: #30363d; --text: #e6edf3;
    --dim: #8b949e; --amber: #ffbf00; --red: #d21f1f; --green: #2ea043;
    --baize: #0a5c34;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    min-height: 100vh;
  }
  header.topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--edge);
    background: var(--panel);
  }
  header.topbar h1 { font-size: 16px; letter-spacing: 1px; text-transform: uppercase; }
  header.topbar .spacer { flex: 1; }

  /* IR-1 / AC-1: angry blinking red notification banner */
  @keyframes angry-blink {
    0%, 100% { background: var(--red); box-shadow: 0 0 24px rgba(210,31,31,.9); }
    50% { background: #7a0c0c; box-shadow: 0 0 4px rgba(210,31,31,.3); }
  }
  [data-testid="notification-banner"] {
    display: none; align-items: center; justify-content: center; gap: 10px;
    color: #fff; background: var(--red); font-weight: 800;
    letter-spacing: 2px; padding: 10px 16px; font-size: 15px;
    animation: angry-blink 0.6s step-end infinite;
  }
  [data-testid="notification-banner"].active { display: flex; }
  [data-testid="notification-banner"] .icon {
    display: inline-flex; width: 22px; height: 22px; border-radius: 50%;
    border: 2px solid #fff; align-items: center; justify-content: center;
    font-weight: 900; flex: none;
  }
  [data-testid="notification-banner"] .detail {
    font-weight: 400; letter-spacing: 0; font-size: 12px; opacity: .9;
  }

  main.layout { display: grid; grid-template-columns: 1fr 340px; gap: 14px; padding: 14px; }
  main.layout.tv { grid-template-columns: 1fr; max-width: 1100px; margin: 0 auto; }
  .stack { display: flex; flex-direction: column; gap: 14px; }
  .panel {
    background: var(--panel); border: 1px solid var(--edge); border-radius: 8px;
    padding: 12px;
  }
  .panel h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px;
    color: var(--dim); margin-bottom: 8px;
  }

  /* IR-2 / AC-2: camera feed at 16:9 */
  [data-testid="camera-feed-container"] { padding: 0; overflow: hidden; }
  [data-testid="camera-feed-placeholder"] {
    position: relative; width: 100%; aspect-ratio: 16 / 9;
    background: repeating-linear-gradient(45deg, #0a2e1c, #0a2e1c 12px, #0c3521 12px, #0c3521 24px);
    display: flex; align-items: center; justify-content: center;
  }
  [data-testid="camera-feed-placeholder"] canvas {
    position: absolute; inset: 0; width: 100%; height: 100%;
    image-rendering: pixelated;
  }
  .cam-label {
    position: absolute; top: 8px; left: 10px; z-index: 2; font-size: 11px;
    background: rgba(0,0,0,.55); padding: 2px 8px; border-radius: 4px;
    color: var(--dim); letter-spacing: 1px;
  }
  .cam-live { color: #ff5b5b; font-weight: 700; }

  /* IR-3: player score cards */
  .scoreboard { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: stretch; }
  .player-card {
    border: 1px solid var(--edge); border-radius: 8px; padding: 10px 14px;
    display: flex; flex-direction: column; gap: 4px; background: #10151c;
  }
  .player-card .name { font-size: 14px; color: var(--dim); display: flex; align-items: center; gap: 8px; }
  .player-card .score { font-size: 42px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .player-card.active { border-color: var(--green); }
  .player-card .active-indicator {
    display: none; width: 9px; height: 9px; border-radius: 50%;
    background: var(--green); box-shadow: 0 0 8px var(--green); flex: none;
  }
  .player-card.active .active-indicator { display: inline-block; }
  .centre-box { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-width: 130px; }

  /* IR-4: break in amber */
  [data-testid="current-break"] {
    color: var(--amber); font-size: 30px; font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  .break-label, .frame-label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: 1.5px; }
  [data-testid="frame-info"] { text-align: center; font-size: 13px; color: var(--dim); }
  [data-testid="current-frame"] { color: var(--text); font-weight: 700; }
  .meta-row { display: flex; gap: 18px; justify-content: center; font-size: 13px; color: var(--dim); flex-wrap: wrap; }
  .meta-row b { color: var(--text); }
  .ball-on-dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; vertical-align: baseline; margin-right: 4px; border: 1px solid #0008; }

  /* Event log */
  [data-testid="event-log"] {
    list-style: none; max-height: 260px; overflow-y: auto; font-size: 12px;
    display: flex; flex-direction: column; gap: 4px;
  }
  [data-testid="event-log"] li {
    padding: 4px 8px; border-left: 3px solid var(--edge); background: #10151c;
    border-radius: 0 4px 4px 0; color: var(--dim);
  }
  [data-testid="event-log"] li b { color: var(--text); font-weight: 600; }
  [data-testid="event-log"] li.src-human { border-left-color: var(--amber); }
  [data-testid="event-log"] li.src-vision { border-left-color: var(--green); }
  [data-testid="event-log"] li.type-FOUL, [data-testid="event-log"] li.type-NOTIFICATION { border-left-color: var(--red); }

  /* Corrections */
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  button, select, input {
    font: inherit; color: var(--text); background: #21262d;
    border: 1px solid var(--edge); border-radius: 6px; padding: 8px 10px;
    cursor: pointer;
  }
  button:hover { background: #30363d; }
  button.primary { background: var(--green); border-color: var(--green); color: #fff; font-weight: 700; }
  button.danger { background: var(--red); border-color: var(--red); color: #fff; font-weight: 700; }
  label.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dim); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .status-list { font-size: 12px; color: var(--dim); display: flex; flex-direction: column; gap: 4px; }
  .status-list b { color: var(--text); }

  /* IR-6: calibration modal */
  [data-testid="calibration-modal"] {
    display: none; position: fixed; inset: 0; z-index: 50;
    background: rgba(2,6,10,.8); align-items: center; justify-content: center;
  }
  [data-testid="calibration-modal"].open { display: flex; }
  [data-testid="calibration-modal"] .dialog {
    background: var(--panel); border: 1px solid var(--edge); border-radius: 10px;
    max-width: 480px; width: 92%; padding: 20px; display: flex; flex-direction: column; gap: 12px;
  }
  [data-testid="calibration-modal"] ol { padding-left: 20px; font-size: 13px; color: var(--dim); display: flex; flex-direction: column; gap: 6px; }
  .tag { font-size: 10px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--edge); color: var(--dim); letter-spacing: 1px; text-transform: uppercase; }
  .tag.ok { color: var(--green); border-color: var(--green); }
  .tag.warn { color: var(--amber); border-color: var(--amber); }
`;

/** Shared client-side rendering script (control + TV). */
const SHARED_JS = /* js */ `
  const BALL_HEX = { red:'#c81e1e', yellow:'#ebd732', green:'#0a5c34', brown:'#82461e',
    blue:'#1e3cc8', pink:'#eb82a0', black:'#111', cue:'#f0f0dc', colour:'#8b949e' };
  const $ = (id) => document.querySelector('[data-testid="' + id + '"]');

  function renderShared(s) {
    // Notification banner (IR-1)
    const banner = $('notification-banner');
    banner.classList.toggle('active', s.notification.active);
    banner.querySelector('.detail').textContent = s.notification.active ? '— ' + s.notification.message : '';

    // Scores + active player (IR-3)
    for (const p of [1, 2]) {
      const card = $('player-' + p + '-score');
      card.classList.toggle('active', s.activePlayer === p && s.phase !== 'match_over');
      card.querySelector('.name .label').textContent = s.players[p];
      card.querySelector('.score').textContent = s.scores[p];
      card.querySelector('.frames').textContent = 'Frames: ' + s.framesWon[p];
    }

    // Break (IR-4) + frame info (AC-5)
    $('current-break').textContent = s.currentBreak;
    $('current-frame').textContent = s.frameNumber;
    document.getElementById('best-of').textContent = s.bestOf;

    // Ball on / remaining / shot timer / phase
    const ballOn = s.ballOn;
    const dot = document.getElementById('ball-on-dot');
    dot.style.background = BALL_HEX[ballOn] || '#8b949e';
    document.getElementById('ball-on').textContent = ballOn.toUpperCase();
    document.getElementById('remaining').textContent = s.remainingPoints;
    document.getElementById('reds-remaining').textContent = s.redsRemaining;
    document.getElementById('phase').textContent = s.phase.replace(/_/g, ' ');
    const timerS = Math.max(0, Math.floor((s.now - s.shotTimerStartedAt) / 1000));
    document.getElementById('shot-timer').textContent = timerS + 's';

    // Event log (FR-5, AC-6): newest first
    const log = $('event-log');
    log.innerHTML = s.eventLog.slice().reverse().map(e =>
      '<li class="src-' + e.source + ' type-' + e.type + '"><b>' + e.type + '</b> ' +
      escapeHtml(e.message) + '</li>').join('');

    // Status panel
    const st = document.getElementById('model-name');
    if (st) st.textContent = s.status.modelName;
    const cal = document.getElementById('calibrated');
    if (cal) { cal.textContent = s.status.calibrated ? 'calibrated' : 'not calibrated';
      cal.className = 'tag ' + (s.status.calibrated ? 'ok' : 'warn'); }
    const fps = document.getElementById('fps');
    if (fps) fps.textContent = s.status.fps + ' fps';
    const fb = document.getElementById('fallback');
    if (fb) { fb.textContent = s.status.fallbackActive ? 'FALLBACK' : 'vision ok';
      fb.className = 'tag ' + (s.status.fallbackActive ? 'warn' : 'ok'); }
    const ftc = document.getElementById('finetune-count');
    if (ftc) ftc.textContent = s.fineTuningCount;
  }

  function escapeHtml(t) {
    return t.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function connectStream(onState) {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => onState(JSON.parse(ev.data));
    es.onerror = () => setTimeout(() => { es.close(); connectStream(onState); }, 1500);
  }

  // Camera painter: poll latest frame, draw raw RGB onto the canvas (IR-2).
  function startCamera() {
    const canvas = document.getElementById('camera-canvas');
    const ctx = canvas.getContext('2d');
    async function tick() {
      try {
        const res = await fetch('/api/frame');
        const body = await res.json();
        const f = body.raw || body.canonical;
        if (f) {
          canvas.width = f.width; canvas.height = f.height;
          const bytes = Uint8Array.from(atob(f.rgb), c => c.charCodeAt(0));
          const img = ctx.createImageData(f.width, f.height);
          for (let i = 0, j = 0; i < bytes.length; i += 3, j += 4) {
            img.data[j] = bytes[i]; img.data[j+1] = bytes[i+1];
            img.data[j+2] = bytes[i+2]; img.data[j+3] = 255;
          }
          ctx.putImageData(img, 0, 0);
          document.getElementById('cam-status').textContent = 'LIVE';
          document.getElementById('cam-status').className = 'cam-live';
        }
      } catch {}
      setTimeout(tick, 200);
    }
    tick();
  }
`;

function bannerHtml(): string {
  return `
  <div data-testid="notification-banner" role="alert">
    <span class="icon">!</span>
    <span>HUMAN INTERVENTION REQUIRED</span>
    <span class="detail"></span>
  </div>`;
}

function cameraHtml(): string {
  return `
  <section class="panel" data-testid="camera-feed-container">
    <div data-testid="camera-feed-placeholder">
      <span class="cam-label">CAMERA 1 — OVERHEAD · <span id="cam-status">connecting…</span></span>
      <canvas id="camera-canvas" width="320" height="180"></canvas>
    </div>
  </section>`;
}

function scoreboardHtml(): string {
  return `
  <section class="panel">
    <div class="scoreboard">
      <div class="player-card" data-testid="player-1-score">
        <span class="name"><span class="active-indicator"></span><span class="label">Player 1</span></span>
        <span class="score">0</span>
        <span class="frames">Frames: 0</span>
      </div>
      <div class="centre-box">
        <span class="break-label">Break</span>
        <span data-testid="current-break">0</span>
        <div data-testid="frame-info">
          <span class="frame-label">Frame</span>
          <div><span data-testid="current-frame">1</span> of <span id="best-of">7</span></div>
        </div>
      </div>
      <div class="player-card" data-testid="player-2-score">
        <span class="name"><span class="active-indicator"></span><span class="label">Player 2</span></span>
        <span class="score">0</span>
        <span class="frames">Frames: 0</span>
      </div>
    </div>
    <div class="meta-row" style="margin-top:10px">
      <span>BALL ON: <span class="ball-on-dot" id="ball-on-dot"></span><b id="ball-on">RED</b></span>
      <span>REMAINING: <b id="remaining">147</b></span>
      <span>REDS: <b id="reds-remaining">15</b></span>
      <span>SHOT TIMER: <b id="shot-timer">0s</b></span>
      <span>PHASE: <b id="phase">setup</b></span>
    </div>
  </section>`;
}

function eventLogHtml(): string {
  return `
  <section class="panel">
    <h2>Event log</h2>
    <ul data-testid="event-log"></ul>
  </section>`;
}

export function controlPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Snooker Match — Control</title>
<style>${CSS}</style>
</head>
<body>
  <header class="topbar">
    <h1>Snooker Match</h1>
    <span class="tag ok">operator</span>
    <span class="spacer"></span>
    <span class="tag" id="fallback">vision ok</span>
    <span class="tag" id="calibrated">not calibrated</span>
    <button data-testid="calibrate-button" id="calibrate-button">Recalibrate camera</button>
  </header>
  ${bannerHtml()}
  <main class="layout">
    <div class="stack">
      ${cameraHtml()}
      ${scoreboardHtml()}
      ${eventLogHtml()}
    </div>
    <div class="stack">
      <section class="panel">
        <h2>Match setup</h2>
        <div class="stack" style="gap:8px">
          <div class="grid-2">
            <label class="field">Player 1 <input id="setup-p1" value="Player 1" /></label>
            <label class="field">Player 2 <input id="setup-p2" value="Player 2" /></label>
          </div>
          <label class="field">Rule preset
            <select data-testid="rule-preset-select" id="rule-preset-select">
              <option value="professional">Professional</option>
              <option value="amateur">Amateur</option>
              <option value="club">Club</option>
            </select>
          </label>
          <label class="field">Confidence threshold: <b id="threshold-value">0.60</b>
            <input type="range" min="0" max="1" step="0.05" value="0.6"
              data-testid="confidence-slider" id="confidence-slider" />
          </label>
          <button class="primary" id="start-match">Start match</button>
        </div>
      </section>

      <section class="panel" data-testid="panel-corrections">
        <h2>Corrections</h2>
        <div class="stack" style="gap:8px">
          <div class="grid-2">
            <button data-testid="correction-pot-missed" data-correction="POT_MISSED">POT MISSED</button>
            <button data-correction="WRONG_COLOUR">WRONG COLOUR</button>
            <button class="danger" data-correction="FOUL">FOUL</button>
            <button data-correction="UNDO">UNDO</button>
            <button data-correction="SWITCH_PLAYER">SWITCH PLAYER</button>
            <button data-correction="CORRECT_SCORE">CORRECT SCORE</button>
          </div>
          <label class="field">Ball involved
            <select id="correction-colour">
              <option>red</option><option>yellow</option><option>green</option>
              <option>brown</option><option>blue</option><option>pink</option>
              <option>black</option><option>cue</option>
            </select>
          </label>
          <div class="grid-2">
            <label class="field">P1 score <input id="manual-score-1" type="number" min="0" value="0" /></label>
            <label class="field">P2 score <input id="manual-score-2" type="number" min="0" value="0" /></label>
          </div>
          <button class="primary" data-testid="apply-correction-button" id="apply-correction-button">
            Apply correction
          </button>
          <div class="status-list"><span>Recorded for fine-tuning: <b id="finetune-count">0</b></span></div>
        </div>
      </section>

      <section class="panel">
        <h2>System status</h2>
        <div class="status-list">
          <span>Model: <b id="model-name">(loading)</b></span>
          <span>Camera: <b id="fps">0 fps</b></span>
          <span>TV view: <b>http://&lt;tablet-ip&gt;:PORT/tv</b></span>
        </div>
      </section>
    </div>
  </main>

  <div data-testid="calibration-modal" id="calibration-modal">
    <div class="dialog">
      <h2 style="font-size:15px;color:var(--text)">Camera calibration</h2>
      <p style="font-size:13px;color:var(--dim)">
        Guided sequence — one pass, about a minute:
      </p>
      <ol>
        <li>Clear the table, then tap the four cushion corners on the camera
            view in order: top-left, top-right, bottom-right, bottom-left.</li>
        <li>Place every colour on its spot and rack the reds (standard
            break-off layout), then keep hands clear of the table.</li>
        <li>Press <b>Begin calibration</b>. The system captures labelled
            frames, learns this table's colours, and updates the model.</li>
      </ol>
      <div class="row">
        <button class="primary" data-testid="begin-calibration-button" id="begin-calibration-button">
          Begin calibration
        </button>
        <button id="close-calibration">Close</button>
      </div>
      <p id="calibration-status" style="font-size:12px;color:var(--dim)"></p>
    </div>
  </div>

<script>
${SHARED_JS}

  const post = (path, body) => fetch(path + '?role=operator', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-role': 'operator' },
    body: JSON.stringify(body || {}),
  }).then(r => r.json());

  let pendingCorrection = null;
  document.querySelectorAll('[data-correction]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingCorrection = btn.dataset.correction;
      document.querySelectorAll('[data-correction]').forEach(b => b.style.outline = '');
      btn.style.outline = '2px solid var(--amber)';
      // Quick buttons apply immediately for one-tap flow (AC-6).
      if (pendingCorrection === 'UNDO' || pendingCorrection === 'SWITCH_PLAYER') applyCorrection();
    });
  });

  function applyCorrection() {
    if (!pendingCorrection) return;
    const body = { type: pendingCorrection, colour: document.getElementById('correction-colour').value };
    if (pendingCorrection === 'CORRECT_SCORE') {
      body.scores = { 1: Number(document.getElementById('manual-score-1').value),
                      2: Number(document.getElementById('manual-score-2').value) };
    }
    post('/api/correction', body);
    pendingCorrection = null;
    document.querySelectorAll('[data-correction]').forEach(b => b.style.outline = '');
  }
  document.getElementById('apply-correction-button').addEventListener('click', applyCorrection);

  document.getElementById('start-match').addEventListener('click', () => {
    post('/api/setup', {
      start: true,
      player1: document.getElementById('setup-p1').value,
      player2: document.getElementById('setup-p2').value,
      rulePreset: document.getElementById('rule-preset-select').value,
      confidenceThreshold: Number(document.getElementById('confidence-slider').value),
    });
  });
  document.getElementById('rule-preset-select').addEventListener('change', (e) => {
    post('/api/setup', { rulePreset: e.target.value });
  });
  document.getElementById('confidence-slider').addEventListener('change', (e) => {
    document.getElementById('threshold-value').textContent = Number(e.target.value).toFixed(2);
    post('/api/setup', { confidenceThreshold: Number(e.target.value) });
  });

  // Calibration modal (IR-6, AC-7)
  const modal = document.getElementById('calibration-modal');
  document.getElementById('calibrate-button').addEventListener('click', () => modal.classList.add('open'));
  document.getElementById('close-calibration').addEventListener('click', () => modal.classList.remove('open'));
  document.getElementById('begin-calibration-button').addEventListener('click', async () => {
    const status = document.getElementById('calibration-status');
    status.textContent = 'Setting corners + capturing frames…';
    await post('/api/calibration/corners', {});
    const res = await post('/api/calibration/begin', {});
    status.textContent = res.ok
      ? 'Calibration complete — colours learned, frames captured for fine-tuning.'
      : 'Calibration failed: ' + (res.error || 'unknown error');
  });

  connectStream(renderShared);
  startCamera();
</script>
</body>
</html>`;
}

export function tvPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Snooker Match — TV</title>
<style>${CSS}</style>
</head>
<body>
  <header class="topbar">
    <h1>Snooker Match</h1>
    <span class="tag">read-only viewer</span>
    <span class="spacer"></span>
    <span class="tag" id="fallback">vision ok</span>
  </header>
  ${bannerHtml()}
  <main class="layout tv" data-testid="tv-main-view">
    <div class="stack">
      ${cameraHtml()}
      ${scoreboardHtml()}
      ${eventLogHtml()}
    </div>
  </main>
<script>
${SHARED_JS}
  connectStream(renderShared);
  startCamera();
</script>
</body>
</html>`;
}
