/* Viessmann dashboard — client (homebridge-viessmann-vicare 2.0.81+; CSRF token and PIN since 2.0.82) */
(function () {
  'use strict';
  const BOOT = JSON.parse(document.getElementById('boot').textContent);
  const IT = BOOT.lang === 'it';
  const tr = (it, en) => (IT ? it : en);
  const LOC = IT ? 'it-IT' : 'en-GB';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n, d = 1) => (n === null || n === undefined || !isFinite(n)) ? '—' : Number(n).toLocaleString(LOC, { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtDate = (ds) => ds ? new Date(String(ds).length === 10 ? ds + 'T12:00:00' : ds).toLocaleDateString(LOC, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
  const fmtDT = (ds) => ds ? new Date(ds).toLocaleString(LOC, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const ago = (sec) => sec === null || sec === undefined ? '—' : sec < 90 ? tr(`${sec} s fa`, `${sec} s ago`) : sec < 5400 ? tr(`${Math.round(sec / 60)} min fa`, `${Math.round(sec / 60)} min ago`) : sec < 172800 ? tr(`${Math.round(sec / 3600)} ore fa`, `${Math.round(sec / 3600)} h ago`) : tr(`${Math.round(sec / 86400)} giorni fa`, `${Math.round(sec / 86400)} days ago`);
  const store = { get(k, d) { try { const v = localStorage.getItem('vicare.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('vicare.' + k, JSON.stringify(v)); } catch { /* private mode */ } } };
  // Every change carries the CSRF token of this page; with a dashboard PIN the server answers
  // 401 "locked" until the PIN is entered, then the request is sent again.
  const SEC = { pinRequired: !!BOOT.pinRequired, unlocked: BOOT.unlocked !== false };
  const api = async (method, url, data, retried) => {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Vicare-Csrf': BOOT.csrf || '' }, body: data ? JSON.stringify(data) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 403 && j.error === 'csrf') { location.reload(); throw new Error(tr('pagina scaduta, la ricarico', 'page expired, reloading')); }
    if (r.status === 401 && j.error === 'locked' && !retried) { SEC.unlocked = false; renderPills(); if (await askPin()) return api(method, url, data, true); throw new Error(tr('serve il PIN', 'PIN needed')); }
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  // PIN dialog (only when dashboardPin is set in the plugin settings)
  function askPin() {
    return new Promise((resolve) => {
      const m = document.createElement('div');
      m.className = 'modal';
      m.innerHTML = `<form class="card mbox"><h2>${icon('key')} ${tr('PIN della dashboard', 'Dashboard PIN')}</h2>
        <p class="intro">${tr('Le modifiche sono protette da un PIN (impostazioni del plugin, “dashboardPin”). Questo browser resterà sbloccato per 30 giorni.', 'Changes are protected by a PIN (plugin settings, “dashboardPin”). This browser stays unlocked for 30 days.')}</p>
        <input type="password" inputmode="numeric" autocomplete="current-password" id="pin-in" required>
        <div class="err" id="pin-err"></div>
        <div class="btns"><button class="btn primary" type="submit">${tr('Sblocca', 'Unlock')}</button><button class="btn" type="button" id="pin-x">${tr('Annulla', 'Cancel')}</button></div></form>`;
      document.body.appendChild(m);
      const done = (v) => { m.remove(); resolve(v); };
      $('#pin-in', m).focus();
      $('#pin-x', m).onclick = () => done(false);
      $('form', m).onsubmit = async (e) => {
        e.preventDefault();
        const r = await fetch('/api/unlock', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Vicare-Csrf': BOOT.csrf || '' }, body: JSON.stringify({ pin: $('#pin-in', m).value }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok) { SEC.unlocked = true; renderPills(); done(true); return; }
        $('#pin-err', m).textContent = r.status === 429 ? tr(`Troppi tentativi: riprova tra ${Math.ceil((j.retryInSec || 900) / 60)} minuti.`, `Too many attempts: try again in ${Math.ceil((j.retryInSec || 900) / 60)} minutes.`)
          : r.status === 403 && j.error === 'csrf' ? tr('Pagina scaduta: ricaricala.', 'Page expired: reload it.')
          : tr(`PIN errato (${j.left ?? 0} tentativi rimasti).`, `Wrong PIN (${j.left ?? 0} attempts left).`);
      };
    });
  }
  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); };
  const IC = {
    curve: '<path d="M3 20c4 0 5-9 9-9s5-7 9-7"/><path d="M3 4v16h18"/>',
    flame: '<path d="M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3-1-3 0-6 1-8z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-8"/>',
    doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
    pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  };
  const icon = (n) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${IC[n]}</svg>`;

  let S = { auth: BOOT.auth, api: null, installations: [], reports: [], combustion: null };

  // ── layout ─────────────────────────────────────────────────────────────────
  document.getElementById('app').innerHTML = `
  <header><div class="hin"><div class="logo"><svg viewBox="0 0 24 24"><path fill="#f97316" d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3-1-3 0-6 1-9z"/></svg><div>Viessmann ViCare<br><small>Homebridge · v${esc(BOOT.version)}</small></div></div><div class="pills" id="pills"></div></div></header>
  <main>
    <section class="card" id="auth"></section>
    <section class="card c5" id="status"></section>
    <section class="card c7" id="report"></section>
    <section class="card" id="curve"></section>
    <section class="card" id="saved"></section>
    <section class="card" id="comb"></section>
    <footer>${tr('Tutti i dati restano sul tuo Homebridge. Questa pagina è raggiungibile solo dalla rete di casa.', 'All data stays on your Homebridge. This page is only reachable from your home network.')}</footer>
  </main><div class="toast" id="toast"></div>`;

  // ── header pills ───────────────────────────────────────────────────────────
  function renderPills() {
    const a = S.auth, p = [];
    if (a) p.push(`<span class="pill"><span class="dot ${a.state === 'authenticated' ? 'good' : 'bad'}"></span>${a.state === 'authenticated' ? tr('Collegato a Viessmann', 'Connected to Viessmann') : tr('Accesso richiesto', 'Login required')}</span>`);
    if (S.api) { const pct = S.api.dailyUsagePct ?? 0; p.push(`<span class="pill"><span class="dot ${pct > 80 ? 'bad' : pct > 50 ? 'warn' : 'good'}"></span>API ${Math.round(pct)}%</span>`); }
    const inst = S.installations[0];
    if (inst) { const age = Math.round((Date.now() - new Date(inst.updated)) / 1000); p.push(`<span class="pill"><span class="dot ${age > 3600 ? 'warn' : 'good'}"></span>${tr('Dati', 'Data')} ${ago(age)}</span>`); }
    if (SEC.pinRequired) p.push(`<button class="pill lockpill" id="lockpill" type="button">${SEC.unlocked ? '🔓 ' + tr('Modifiche sbloccate', 'Changes unlocked') : '🔒 ' + tr('Modifiche bloccate', 'Changes locked')}</button>`);
    $('#pills').innerHTML = p.join('');
    const lp = $('#lockpill');
    if (lp) lp.onclick = async () => {
      if (SEC.unlocked) { await api('POST', '/api/lock').catch(() => null); SEC.unlocked = false; renderPills(); toast(tr('Modifiche bloccate', 'Changes locked')); }
      else if (await askPin()) toast(tr('Modifiche sbloccate', 'Changes unlocked'));
    };
  }

  // ── login ──────────────────────────────────────────────────────────────────
  function renderAuth() {
    const a = S.auth, el = $('#auth');
    if (!el) return;
    if (!a) { el.remove(); return; }
    if (a.state !== 'authenticated') {
      el.className = 'card hero';
      el.innerHTML = `<h2>${icon('key')} ${tr('Collega il tuo account Viessmann', 'Connect your Viessmann account')}</h2>
      <p class="intro">${tr('Il plugin non ha ancora un accesso valido: senza, Home non può leggere né comandare la caldaia.', 'The plugin has no valid login yet: without it, Home cannot read or control the boiler.')}</p>
      ${a.authUrl ? `<a class="btn primary big" href="${esc(a.authUrl)}">${tr('Accedi a Viessmann', 'Log in to Viessmann')} →</a>` : `<button class="btn primary big" type="button" id="au-login">${tr('Accedi a Viessmann', 'Log in to Viessmann')} →</button>`}
      <ol class="steps"><li>${tr('Accedi con le stesse credenziali dell’app ViCare', 'Log in with your ViCare app credentials')}${a.username ? ` (<b>${esc(a.username)}</b>)` : ''}.</li>
      <li>${tr('Conferma l’accesso: tornerai automaticamente qui.', 'Confirm access: you will come back here automatically.')}</li>
      <li>${tr('Se Viessmann segnala “redirect_uri” non valido, nel portale sviluppatori Viessmann deve essere registrato esattamente', 'If Viessmann reports an invalid “redirect_uri”, the Viessmann developer portal must list exactly')} <code>${esc(a.redirectUri)}</code></li></ol>`;
      wireAuth();
      return;
    }
    el.className = 'card c6';
    const days = a.refreshTokenExpiresInDays;
    el.innerHTML = `<h2>${icon('key')} ${tr('Accesso Viessmann', 'Viessmann login')}</h2>
      <p class="intro">${tr('Il plugin rinnova da solo il token. Serve rifare l’accesso solo se scade il rinnovo o cambi password.', 'The plugin renews the token by itself. Log in again only if renewal expires or you change password.')}</p>
      <div class="rows">
        <div class="row"><span class="k">${tr('Stato', 'Status')}</span><span class="v good">✓ ${tr('collegato', 'connected')}</span></div>
        ${a.username ? `<div class="row"><span class="k">${tr('Account', 'Account')}</span><span class="v">${esc(a.username)}</span></div>` : ''}
        <div class="row"><span class="k">${tr('Token attuale', 'Current token')}</span><span class="v">${a.expiresInSeconds ? tr(`valido ancora ${Math.round(a.expiresInSeconds / 60)} min`, `valid for ${Math.round(a.expiresInSeconds / 60)} min`) : '—'}</span></div>
        <div class="row"><span class="k">${tr('Rinnovo automatico', 'Automatic renewal')}</span><span class="v ${days !== null && days < 14 ? 'warn' : ''}">${a.hasRefreshToken ? (days !== null ? tr(`ancora ${days} giorni`, `${days} more days`) : tr('attivo', 'active')) : tr('non disponibile', 'not available')}</span></div>
      </div>
      <div class="btns"><button class="btn" type="button" id="au-login">${tr('Rifai l’accesso', 'Log in again')}</button>
      <button class="btn danger" type="button" id="au-clear">${tr('Disconnetti', 'Disconnect')}</button></div>`;
    wireAuth();
  }
  function wireAuth() {
    const l = $('#au-login'), c = $('#au-clear');
    if (l) l.onclick = async () => {
      try { const j = await api('POST', '/reauth'); if (j.authUrl) location.href = j.authUrl; } catch (e) { toast(tr('Errore: ', 'Error: ') + e.message); }
    };
    if (c) c.onclick = async () => {
      if (!confirm(tr('Disconnettere il plugin da Viessmann? Home smetterà di funzionare finché non rifai l’accesso.', 'Disconnect the plugin from Viessmann? Home stops working until you log in again.'))) return;
      try { await api('POST', '/clear'); location.reload(); } catch (e) { toast(tr('Errore: ', 'Error: ') + e.message); }
    };
  }

  // ── status ─────────────────────────────────────────────────────────────────
  function renderStatus() {
    const a = S.api, el = $('#status');
    if (S.auth && S.auth.state === 'authenticated') el.className = 'card c6';
    const pct = a ? Math.round(a.dailyUsagePct ?? 0) : null, lvl = pct === null ? '' : pct > 80 ? 'bad' : pct > 50 ? 'warn' : '';
    el.innerHTML = `<h2>${icon('pulse')} ${tr('Stato del collegamento', 'Connection status')}</h2>
      <p class="intro">${tr('Viessmann permette circa 1450 richieste al giorno: il plugin si regola da solo per non superarle.', 'Viessmann allows about 1450 requests a day: the plugin adapts itself to stay below.')}</p>
      <div class="rows">
      ${a ? `<div class="row"><span class="k">${tr('Uso giornaliero API', 'Daily API usage')}</span><span class="v"><span class="bar"><i class="${lvl}" style="width:${Math.min(pct, 100)}%"></i></span>${pct}% <small class="muted">(~${a.dailyEstimatedReqs ?? '?'}/${a.dailyLimitTotal ?? 1450})</small></span></div>
      <div class="row"><span class="k">${tr('Limite di richieste', 'Rate limit')}</span><span class="v ${a.isRateLimited || a.dailyQuotaExceeded ? 'bad' : 'good'}">${a.isRateLimited ? tr(`bloccato, riprova tra ${a.rateLimitWaitSec} s`, `blocked, retry in ${a.rateLimitWaitSec} s`) : a.dailyQuotaExceeded ? tr('quota giornaliera finita', 'daily quota used up') : '✓ OK'}</span></div>
      <div class="row"><span class="k">${tr('Risposta media · errori', 'Avg response · errors')}</span><span class="v">${a.avgResponseTime ?? 0} ms · <span class="${a.errorRate > 10 ? 'bad' : a.errorRate > 5 ? 'warn' : ''}">${a.errorRate ?? 0}%</span></span></div>
      <div class="row"><span class="k">${tr('Ultimo aggiornamento', 'Last update')}</span><span class="v">${ago(a.ageSec)}</span></div>`
      : `<div class="row"><span class="k">API</span><span class="v muted">${tr('in attesa del primo aggiornamento', 'waiting for the first update')}</span></div>`}
      ${S.installations.map((i) => `<div class="row"><span class="k">${tr('Storico', 'History')} ${i.id ? tr('impianto ', 'installation ') + esc(i.id) : ''}</span><span class="v">${nf(i.sizeKB / 1024, 1)} MB · ${ago(Math.round((Date.now() - new Date(i.updated)) / 1000))}</span></div>`).join('')}
      </div>`;
  }

  // ── report form ────────────────────────────────────────────────────────────
  const R = store.get('report', { days: 7, lang: BOOT.lang, gasPrice: '', elPrice: '', boilerKW: '', designTemp: '', curveSlope: '', curveShift: '' });
  function renderReportForm() {
    const el = $('#report');
    const inst = S.installations;
    const cv = (inst[0] && inst[0].curve) || null;
    el.innerHTML = `<h2>${icon('chart')} ${tr('Crea un report', 'Create a report')}</h2>
      <p class="intro">${tr('Il report analizza consumi, comfort, caldaia, acqua calda e analisi fumi, con consigli e risparmi stimati. Viene salvato qui sotto e resta disponibile per', 'The report analyses consumption, comfort, boiler, hot water and flue gas analyses, with advice and estimated savings. It is saved below and kept for')} ${BOOT.retentionDays} ${tr('giorni', 'days')}.</p>
      <div class="presets" id="presets">${[1, 7, 30, 90, 365].map((d) => `<button class="preset ${R.days === d ? 'on' : ''}" data-d="${d}">${d === 1 ? tr('1 giorno', '1 day') : d === 365 ? tr('1 anno', '1 year') : `${d} ${tr('giorni', 'days')}`}</button>`).join('')}</div>
      <div class="grid">
        <div><label class="f">${tr('Giorni', 'Days')}</label><input id="r-days" type="number" min="1" max="3650" value="${R.days}"></div>
        ${inst.length > 1 ? `<div class="w2"><label class="f">${tr('Impianto', 'Installation')}</label><select id="r-inst">${inst.map((i) => `<option value="${esc(i.id)}">${esc(i.id || tr('predefinito', 'default'))}</option>`).join('')}</select></div>` : ''}
        <div><label class="f">${tr('Lingua', 'Language')}</label><select id="r-lang"><option value="it" ${R.lang === 'it' ? 'selected' : ''}>Italiano</option><option value="en" ${R.lang === 'en' ? 'selected' : ''}>English</option></select></div>
        <div><label class="f">${tr('Prezzo gas (€/m³)', 'Gas price (€/m³)')}</label><input id="r-gasPrice" inputmode="decimal" placeholder="1,10" value="${esc(R.gasPrice)}"><div class="hint">${tr('Totale bolletta ÷ m³', 'Bill total ÷ m³')}</div></div>
        <div><label class="f">${tr('Prezzo luce (€/kWh)', 'Electricity (€/kWh)')}</label><input id="r-elPrice" inputmode="decimal" placeholder="0,30" value="${esc(R.elPrice)}"></div>
      </div>
      <details><summary>${tr('Opzioni avanzate', 'Advanced options')}</summary><div class="grid">
        <div><label class="f">${tr('Potenza caldaia (kW)', 'Boiler power (kW)')}</label><input id="r-boilerKW" inputmode="decimal" value="${esc(R.boilerKW)}"></div>
        <div><label class="f">${tr('Temp. di progetto (°C)', 'Design temp. (°C)')}</label><input id="r-designTemp" inputmode="decimal" placeholder="${tr('automatica', 'automatic')}" value="${esc(R.designTemp)}"></div>
        <div><label class="f">${tr('Pendenza curva', 'Curve slope')}</label><input id="r-curveSlope" inputmode="decimal" placeholder="${cv ? nf(cv.slope, 1) : '—'}" value="${esc(R.curveSlope)}"><div class="hint">${cv ? tr('letta dalla caldaia: lascia vuoto', 'read from the boiler: leave empty') : tr('solo se la caldaia non la comunica', 'only if the boiler does not report it')}</div></div>
        <div><label class="f">${tr('Spostamento curva', 'Curve shift')}</label><input id="r-curveShift" inputmode="decimal" placeholder="${cv ? nf(cv.shift, 0) : '—'}" value="${esc(R.curveShift)}"><div class="hint">${cv ? tr('letto dalla caldaia: lascia vuoto', 'read from the boiler: leave empty') : tr('solo se la caldaia non lo comunica', 'only if the boiler does not report it')}</div></div>
      </div></details>
      <div class="btns"><button class="btn primary" id="r-go" ${inst.length ? '' : 'disabled'}>${tr('Crea report', 'Create report')}</button></div>
      ${inst.length ? '' : `<p class="err">${tr('Nessuno storico trovato: il plugin deve raccogliere dati per qualche ora.', 'No history found: the plugin needs to collect data for a few hours.')}</p>`}
      <div class="progress" id="r-prog"><span class="spin"></span><span id="r-msg"></span></div><div class="err" id="r-err"></div>`;
    el.querySelectorAll('.preset').forEach((b) => b.onclick = () => { $('#r-days').value = b.dataset.d; el.querySelectorAll('.preset').forEach((x) => x.classList.toggle('on', x === b)); });
    $('#r-days').oninput = () => el.querySelectorAll('.preset').forEach((x) => x.classList.toggle('on', x.dataset.d === $('#r-days').value));
    $('#r-go').onclick = generate;
  }
  async function generate() {
    const v = (id) => ($('#r-' + id) ? $('#r-' + id).value.trim() : '');
    const p = { days: parseInt(v('days'), 10) || 7, installation: v('inst') || (S.installations[0]?.id ?? ''), lang: v('lang'), gasPrice: v('gasPrice'), elPrice: v('elPrice'), boilerKW: v('boilerKW'), designTemp: v('designTemp'), curveSlope: v('curveSlope'), curveShift: v('curveShift') };
    Object.assign(R, p); store.set('report', R);
    const btn = $('#r-go'), prog = $('#r-prog'), msg = $('#r-msg'), err = $('#r-err');
    btn.disabled = true; err.textContent = ''; prog.classList.add('on'); msg.textContent = tr('Avvio…', 'Starting…');
    try {
      const { id } = await api('POST', '/api/reports', p);
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const j = await api('GET', '/api/reports/job?id=' + id);
        if (j.status === 'running') { msg.textContent = tr(`Analisi in corso… ${j.elapsed} s (i report lunghi richiedono qualche minuto)`, `Analysing… ${j.elapsed} s (long reports take a few minutes)`); continue; }
        if (j.status === 'error') throw new Error(j.error);
        prog.classList.remove('on');
        toast(tr('Report pronto', 'Report ready'));
        await refresh();
        const row = document.querySelector(`[data-file="${j.file}"]`); if (row) { row.style.background = 'color-mix(in srgb,var(--accent) 12%,transparent)'; row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        break;
      }
    } catch (e) {
      prog.classList.remove('on');
      err.textContent = e.message === 'busy' ? tr('Ci sono già 2 report in preparazione: riprova tra poco.', 'Two reports are already being prepared: try again shortly.') : tr('Errore: ', 'Error: ') + e.message;
    } finally { btn.disabled = false; }
  }

  // ── saved reports ──────────────────────────────────────────────────────────
  function renderSaved() {
    const el = $('#saved'), list = S.reports;
    el.innerHTML = `<h2>${icon('doc')} ${tr('Report salvati', 'Saved reports')}</h2>
      <p class="intro">${tr(`I report vengono cancellati automaticamente dopo ${BOOT.retentionDays} giorni (impostazione “reportRetentionDays”).`, `Reports are deleted automatically after ${BOOT.retentionDays} days (setting “reportRetentionDays”).`)}</p>
      ${list.length ? `<div class="rlist">${list.map((r) => `<div class="ritem" data-file="${esc(r.file)}"><div class="rinfo"><b>${fmtDT(r.created)}</b><span>${r.days ? `${r.days} ${tr('giorni', 'days')}` : '—'} · ${esc((r.lang || '').toUpperCase())} · ${r.sizeKB} KB</span><span class="muted">${tr('scade il', 'expires')} ${fmtDate(r.expires)}</span></div>
      <div class="ract"><a class="btn sm primary" href="/reports/${encodeURIComponent(r.file)}" target="_blank" rel="noopener">${tr('Apri', 'Open')}</a><button class="btn sm danger" data-del="${esc(r.file)}">${tr('Elimina', 'Delete')}</button></div></div>`).join('')}</div>`
      : `<p class="empty">${tr('Nessun report salvato: creane uno qui sopra.', 'No saved report: create one above.')}</p>`}`;
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!confirm(tr('Eliminare questo report?', 'Delete this report?'))) return;
      await api('DELETE', '/api/reports/' + encodeURIComponent(b.dataset.del)); toast(tr('Report eliminato', 'Report deleted')); refresh();
    });
  }

  // ── flue gas analyses ──────────────────────────────────────────────────────
  const F = [
    ['co2', 'CO₂', '%', tr('anidride carbonica', 'carbon dioxide')], ['o2', 'O₂', '%', tr('ossigeno', 'oxygen')], ['lambda', 'λ', '', tr('eccesso d’aria', 'excess air')],
    ['co', 'CO', 'ppm', tr('monossido misurato', 'measured CO')], ['coUndiluted', 'uCO', 'ppm', tr('CO non diluito (con limite di legge)', 'CO air-free (legal limit)')],
    ['flueTemp', 'TF', '°C', tr('temperatura fumi', 'flue gas temperature')], ['airTemp', 'TA', '°C', tr('temperatura aria', 'air temperature')],
    ['efficiency', tr('Rend.', 'Eff.'), '%', tr('rendimento', 'efficiency')], ['losses', 'Qs', '%', tr('perdite al camino', 'flue losses')],
    ['nox', 'NOx', 'mg/kWh', tr('ossidi di azoto', 'nitrogen oxides')], ['dewPoint', 'tdp', '°C', tr('punto di rugiada', 'dew point')],
  ];
  const effMin = (kw) => kw === null || kw === undefined || kw === '' ? 92 : kw <= 18 ? 91 : kw <= 59.5 ? 92 : kw <= 188 ? 93 : 94;
  function judge(t, kw) {
    const uco = t.coUndiluted ?? (t.co !== undefined && t.o2 !== undefined && t.o2 < 20 ? t.co * 20.9 / (20.9 - t.o2) : null);
    const lv = [];
    if (uco !== null) lv.push(uco < 200 ? 'good' : uco < 1000 ? 'warn' : 'bad');
    if (t.efficiency !== undefined) lv.push(t.efficiency >= effMin(kw) ? 'good' : 'bad');
    if (t.co2 !== undefined) lv.push(t.co2 >= 7.5 && t.co2 <= 10 ? 'good' : 'warn');
    if (t.nox !== undefined) lv.push(t.nox <= 56 ? 'good' : 'warn');
    return { uco, lvl: lv.includes('bad') ? 'bad' : lv.includes('warn') ? 'warn' : 'good' };
  }
  const lvlTxt = { good: tr('nella norma', 'normal'), warn: tr('da tenere d’occhio', 'keep an eye on'), bad: tr('fuori limite', 'out of limits') };
  let editing = null;
  function renderComb() {
    const el = $('#comb'), c = S.combustion || { tests: [] }, t = editing || {};
    const due = (d, date) => `<span class="${d < 0 ? 'bad' : d <= 60 ? 'warn' : 'good'}">${fmtDate(date)}</span><div class="s muted">${d < 0 ? tr(`scaduto da ${-d} giorni`, `overdue by ${-d} days`) : tr(`tra ${d} giorni`, `in ${d} days`)}</div>`;
    const last = c.last ? judge(c.last, c.nominalPowerKW) : null;
    el.innerHTML = `<h2>${icon('flame')} ${tr('Analisi fumi', 'Flue gas analyses')}</h2>
      <p class="intro">${tr('Copia qui i valori dello scontrino del tecnico (prova fumi della manutenzione o del controllo di efficienza). Il report li confronta con i limiti di legge e negli anni, e ti ricorda le scadenze.', 'Copy here the values from the installer’s printout (flue gas test at service or efficiency check). The report compares them with the legal limits and over the years, and reminds you of the due dates.')}</p>
      ${c.last ? `<div class="kpis">
        <div class="kpi"><div class="l">${tr('Ultima analisi', 'Last analysis')}</div><div class="n">${fmtDate(c.last.date)}</div><div class="s"><span class="badge ${last.lvl}">${lvlTxt[last.lvl]}</span></div></div>
        <div class="kpi"><div class="l">CO ${tr('non diluito', 'air-free')}</div><div class="n">${last.uco === null ? '—' : Math.round(last.uco)} <small>ppm</small></div><div class="s muted">${tr('limite 1000', 'limit 1000')}</div></div>
        <div class="kpi"><div class="l">${tr('Rendimento', 'Efficiency')}</div><div class="n">${nf(c.last.efficiency)} <small>%</small></div><div class="s muted">${tr('minimo', 'minimum')} ${effMin(c.nominalPowerKW)} %</div></div>
        <div class="kpi"><div class="l">${icon('cal')} ${tr('Controllo efficienza', 'Efficiency check')}</div><div class="n">${due(c.daysCheck, c.nextCheck)}</div></div>
        <div class="kpi"><div class="l">${icon('cal')} ${tr('Manutenzione', 'Maintenance')}</div><div class="n">${due(c.daysMaint, c.nextMaint)}</div></div>
      </div>` : `<p class="empty">${tr('Nessuna analisi inserita.', 'No analysis entered yet.')}</p>`}
      ${c.tests.length ? `<div class="tw"><table><tr><th>${tr('Data', 'Date')}</th>${F.slice(0, 9).map((f) => `<th>${f[1]}${f[2] ? ` <small>${f[2]}</small>` : ''}</th>`).join('')}</tr>
        ${c.tests.slice().reverse().map((x) => { const j = judge(x, c.nominalPowerKW); const val = (k) => k === 'coUndiluted' ? (j.uco === null ? undefined : j.uco) : x[k]; return `<tr><td>${fmtDate(x.date)}${x.technician ? `<div class="muted" style="font-size:12px">${esc(x.technician)}</div>` : ''}<div class="cact"><span class="badge ${j.lvl}">${lvlTxt[j.lvl]}</span> <button class="btn sm" data-edit="${x.date}">${tr('Modifica', 'Edit')}</button> <button class="btn sm danger" data-cdel="${x.date}">${tr('Elimina', 'Delete')}</button></div></td>${F.slice(0, 9).map((f) => `<td>${val(f[0]) === undefined ? '—' : nf(val(f[0]), ['co', 'coUndiluted'].includes(f[0]) ? 0 : f[0] === 'lambda' || f[0] === 'co2' ? 2 : 1)}</td>`).join('')}</tr>`; }).join('')}</table></div>` : ''}
      <details id="c-form" ${editing || !c.tests.length ? 'open' : ''}><summary>${editing ? tr(`Modifica analisi del ${fmtDate(editing.date)}`, `Edit analysis of ${fmtDate(editing.date)}`) : tr('+ Aggiungi un’analisi', '+ Add an analysis')}</summary>
        <div class="grid">
          <div><label class="f">${tr('Data della prova', 'Test date')} *</label><input id="c-date" type="date" value="${esc(t.date || new Date().toISOString().slice(0, 10))}"></div>
          <div class="w2"><label class="f">${tr('Ditta / tecnico', 'Company / technician')}</label><input id="c-technician" value="${esc(t.technician || '')}"></div>
          ${F.map((f) => `<div><label class="f">${f[1]}${f[2] ? ` (${f[2]})` : ''}</label><input id="c-${f[0]}" inputmode="decimal" value="${t[f[0]] ?? ''}"><div class="hint">${f[3]}</div></div>`).join('')}
          <div class="w2"><label class="f">${tr('Note', 'Notes')}</label><input id="c-notes" value="${esc(t.notes || '')}"></div>
        </div>
        <p class="hint">${tr('Servono almeno la data e CO₂, O₂ o CO. Le sigle sono quelle stampate sullo scontrino (es. testo): TF, TA, uCO, Qs, tdp. Si può usare la virgola.', 'At least the date and CO₂, O₂ or CO are needed. The labels match the printout (e.g. testo): TF, TA, uCO, Qs, tdp. Commas are accepted.')}</p>
        <div class="btns"><button class="btn primary" id="c-save">${tr('Salva analisi', 'Save analysis')}</button>${editing ? `<button class="btn" id="c-cancel">${tr('Annulla', 'Cancel')}</button>` : ''}</div><div class="err" id="c-err"></div>
      </details>
      <details><summary>${tr('Scadenze e caldaia', 'Due dates and boiler')}</summary><div class="grid">
        <div><label class="f">${tr('Potenza caldaia (kW)', 'Boiler power (kW)')}</label><input id="s-kw" inputmode="decimal" value="${c.nominalPowerKW ?? ''}"><div class="hint">${tr('dalla targhetta: decide il rendimento minimo', 'from the label: sets the minimum efficiency')}</div></div>
        <div><label class="f">${tr('Controllo efficienza ogni (anni)', 'Efficiency check every (years)')}</label><input id="s-years" type="number" min="1" max="10" value="${c.efficiencyCheckYears ?? 4}"><div class="hint">${tr('Italia, gas 10–100 kW: 4 anni (verifica la tua regione)', 'Italy, gas 10–100 kW: 4 years (check your region)')}</div></div>
        <div><label class="f">${tr('Manutenzione ogni (mesi)', 'Maintenance every (months)')}</label><input id="s-months" type="number" min="1" max="60" value="${c.maintenanceMonths ?? 12}"><div class="hint">${tr('Viessmann: ogni anno', 'Viessmann: yearly')}</div></div>
        <div><label class="f">${tr('Ultima manutenzione', 'Last maintenance')}</label><input id="s-maint" type="date" value="${c.lastMaintenance ?? ''}"><div class="hint">${tr('se diversa dall’ultima analisi', 'if different from the last analysis')}</div></div>
      </div><div class="btns"><button class="btn" id="s-save">${tr('Salva impostazioni', 'Save settings')}</button></div></details>`;
    el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => { editing = c.tests.find((x) => x.date === b.dataset.edit); renderComb(); $('#c-form').scrollIntoView({ behavior: 'smooth' }); });
    el.querySelectorAll('[data-cdel]').forEach((b) => b.onclick = async () => {
      if (!confirm(tr(`Eliminare l’analisi del ${fmtDate(b.dataset.cdel)}?`, `Delete the analysis of ${fmtDate(b.dataset.cdel)}?`))) return;
      S.combustion = await api('DELETE', '/api/combustion/' + b.dataset.cdel); editing = null; renderComb(); toast(tr('Analisi eliminata', 'Analysis deleted'));
    });
    $('#c-save').onclick = async () => {
      const d = { originalDate: editing ? editing.date : '', date: $('#c-date').value, technician: $('#c-technician').value.trim(), notes: $('#c-notes').value.trim() };
      for (const f of F) d[f[0]] = $('#c-' + f[0]).value.trim();
      try { S.combustion = await api('POST', '/api/combustion', d); editing = null; renderComb(); toast(tr('Analisi salvata', 'Analysis saved')); }
      catch (e) { $('#c-err').textContent = e.message === 'date' ? tr('Data non valida.', 'Invalid date.') : e.message === 'values' ? tr('Inserisci almeno CO₂, O₂, CO o rendimento.', 'Enter at least CO₂, O₂, CO or efficiency.') : e.message; }
    };
    if ($('#c-cancel')) $('#c-cancel').onclick = () => { editing = null; renderComb(); };
    $('#s-save').onclick = async () => {
      S.combustion = await api('PUT', '/api/combustion/settings', { nominalPowerKW: $('#s-kw').value, efficiencyCheckYears: $('#s-years').value, maintenanceMonths: $('#s-months').value, lastMaintenance: $('#s-maint').value });
      renderComb(); toast(tr('Impostazioni salvate', 'Settings saved'));
    };
  }


  // ── heating curve ──────────────────────────────────────────────────────────
  const why = (t) => !t ? '' : !IT ? t : String(t)
    .replace(/^changed: /, 'modificata: ').replace('no heating in the last 48 h', 'nessun riscaldamento nelle ultime 48 ore')
    .replace(/not enough Normal\/Comfort data \((\d+) samples\)/, 'dati Normale/Comfort insufficienti ($1 campioni)')
    .replace(/mild weather \(outdoor ([\d.-]+) °C\)/, 'clima mite (esterno $1 °C)')
    .replace(/room within ±0.5 °C of the program \(([^)]+)\)/, 'stanza entro ±0,5 °C dal programma ($1)')
    .replace(/waiting for the effect of the last change \((\d+) h\)/, 'attendo l’effetto dell’ultima modifica ($1 ore)')
    .replace(/circuit not heating \(([^)]*)\)/, 'circuito non in riscaldamento ($1)').replace('holiday program active', 'programma vacanza attivo')
    .replace(/room ([+-][\d.]+) °C vs the program over 48 h/, 'stanza $1 °C rispetto al programma nelle ultime 48 ore')
    .replace(/room ([+-][\d.]+) °C vs the program/, 'stanza $1 °C rispetto al programma').replace(/(\d+) samples, (\d+) h/, '$1 campioni, $2 ore')
    .replace(/([+-][\d.]+) °C at ([\d.-]+) °C vs ([+-][\d.]+) °C at ([\d.-]+) °C/, '$1 °C con $2 °C fuori, $3 °C con $4 °C')
    .replace(/within ±0.5 °C, no change/, 'entro ±0,5 °C, nessuna modifica').replace(/confidence (\d+) % \(below (\d+) %\)/, 'affidabilità $1 % (sotto $2 %)')
    .replace('(applied from the dashboard)', '(applicata dalla dashboard)').replace(/room cold although the flow is already high/, 'casa fresca con mandata già alta')
    .replace('outdoor', 'esterno').replace(', cold', ', freddo').replace(', mild', ', mite')
    .replace(/: limit reached/, ': limite raggiunto').replace('restored from the dashboard', 'ripristinata dalla dashboard')
    .replace('heating curve not available on this device', 'curva non disponibile su questo dispositivo');
  // Decision of the curve engine, in plain words (codes from src/curve-tuner.ts)
  const num1 = (x) => nf(x, 1);
  function decisionText(d) {
    if (!d) return '';
    const st = d.stats, n = (re) => { const m = String(d.reason || '').match(re); return m ? m[1] : '?'; };
    const room = st ? tr(`La stanza è in media ${st.medianRoomError >= 0 ? '+' : ''}${num1(st.medianRoomError)} °C rispetto al programma (${st.samples} campioni in ${Math.round(st.hours)} ore, esterno ${num1(st.outdoorLow)}…${num1(st.outdoorHigh)} °C).`,
      `The room is on average ${st.medianRoomError >= 0 ? '+' : ''}${num1(st.medianRoomError)} °C vs the program (${st.samples} samples over ${Math.round(st.hours)} h, outdoor ${num1(st.outdoorLow)}…${num1(st.outdoorHigh)} °C).`) : '';
    const byOut = st ? tr(`Con ${num1(st.outdoorLow)} °C fuori la stanza è a ${st.errorAtLow >= 0 ? '+' : ''}${num1(st.errorAtLow)} °C, con ${num1(st.outdoorHigh)} °C a ${st.errorAtHigh >= 0 ? '+' : ''}${num1(st.errorAtHigh)} °C: l’errore dipende dal freddo, quindi va cambiata la pendenza.`,
      `At ${num1(st.outdoorLow)} °C outdoor the room is ${st.errorAtLow >= 0 ? '+' : ''}${num1(st.errorAtLow)} °C, at ${num1(st.outdoorHigh)} °C ${st.errorAtHigh >= 0 ? '+' : ''}${num1(st.errorAtHigh)} °C: the error depends on the cold, so the slope needs changing.`) : '';
    switch (d.reasonCode) {
      case 'NO_HEATING': return tr('Nessun riscaldamento nelle ultime 48 ore: niente da valutare (nessuna chiamata a Viessmann, nulla scritto).', 'No heating in the last 48 h: nothing to evaluate (no Viessmann call, nothing written).');
      case 'MILD_WEATHER': return tr(`Clima mite (esterno ${n(/outdoor ([\d.-]+)/)} °C): niente da valutare.`, `Mild weather (outdoor ${n(/outdoor ([\d.-]+)/)} °C): nothing to evaluate.`);
      case 'CURVE_NOT_AVAILABLE': return tr('La caldaia non permette di leggere o cambiare la curva.', 'The boiler does not allow reading or changing the curve.');
      case 'NOT_HEATING_MODE': return tr('Il circuito non è in riscaldamento.', 'The circuit is not heating.');
      case 'HOLIDAY': return tr('Programma vacanza attivo: niente modifiche.', 'Holiday program active: no changes.');
      case 'WAITING_EFFECT': return tr(`Attendo l’effetto dell’ultima modifica (${n(/\((\d+) h\)/)} ore): la casa reagisce lentamente.`, `Waiting for the effect of the last change (${n(/\((\d+) h\)/)} h): the house reacts slowly.`);
      case 'NOT_ENOUGH_DATA': return tr(`Dati ancora insufficienti (${n(/\((\d+) samples/)} campioni in ${n(/samples, ([\d.]+) h/)} ore con Normale/Comfort in corso): servono almeno 24 campioni su 12 ore.`, `Not enough data yet (${n(/\((\d+) samples/)} samples over ${n(/samples, ([\d.]+) h/)} h with Normal/Comfort running): at least 24 samples over 12 h are needed.`);
      case 'WITHIN_TOLERANCE': return room + ' ' + tr('Entro ±0,5 °C: la curva va bene così.', 'Within ±0.5 °C: the curve is fine.');
      case 'ROOM_COLD': return room + ' ' + tr('Troppo fresco a qualsiasi temperatura esterna: va alzato lo spostamento.', 'Too cool at any outdoor temperature: the shift should go up.');
      case 'ROOM_WARM': return room + ' ' + tr('Troppo caldo a qualsiasi temperatura esterna: va abbassato lo spostamento.', 'Too warm at any outdoor temperature: the shift should go down.');
      case 'ROOM_COLD_WHEN_COLD_OUTSIDE': case 'ROOM_WARM_WHEN_COLD_OUTSIDE': return room + ' ' + byOut;
      case 'HIGH_FLOW_FOR_CURRENT_OUTDOOR': return room + ' ' + tr(`La casa è fresca anche se la mandata è già alta (mediana ${num1(d.flow && d.flow.median)} °C, limite ${num1(d.flow && d.flow.limit)} °C): alzare la curva non risolverebbe. Controlla valvole termostatiche, aria nei radiatori, pompa e posizione della sonda ambiente.`,
        `The house is cool although the flow is already high (median ${num1(d.flow && d.flow.median)} °C, limit ${num1(d.flow && d.flow.limit)} °C): raising the curve would not fix it. Check thermostatic valves, air in the radiators, pump and room sensor position.`);
      case 'LIMIT_REACHED': return room + ' ' + tr('Ma la curva è già al limite consentito rispetto alla curva di partenza.', 'But the curve is already at the allowed limit from the starting curve.');
      default: return why(d.reason);
    }
  }
  const DEC = {
    INCREASE_SLOPE: ['Aumentare la pendenza', 'Increase the slope'], DECREASE_SLOPE: ['Ridurre la pendenza', 'Decrease the slope'],
    INCREASE_SHIFT: ['Alzare lo spostamento', 'Raise the shift'], DECREASE_SHIFT: ['Abbassare lo spostamento', 'Lower the shift'],
    NO_CHANGE: ['Nessuna modifica', 'No change'], WAIT: ['In attesa', 'Waiting'], IDLE: ['Fuori stagione', 'Off season'],
  };
  function renderCurve() {
    const el = $('#curve'), C = S.curve, inst = S.installations[0], cur = inst && inst.curve;
    if (!C || (!C.circuits.length && !cur)) { el.style.display = 'none'; return; }
    el.style.display = '';
    const c = C.circuits[0] || {};
    const base = c.baseline, hist = (c.history || []).slice().reverse(), d = c.lastDecision;
    const modeTxt = !C.enabled ? tr('spenta', 'off') : C.mode === 'proposal' ? tr('solo proposte', 'proposals only') : tr('automatica', 'automatic');
    const canApply = C.enabled && d && d.proposed && d.safety === 'PASS' && !d.applied;
    const confLvl = d ? (d.confidence >= C.autoConfidence ? 'good' : d.confidence >= 50 ? 'warn' : 'bad') : '';
    const decBox = !d ? '' : `<div class="decision ${d.safety === 'VETO' ? 'veto' : canApply ? 'prop' : ''}">
        <div class="dh"><b>${esc(tr(...(DEC[d.decision] || [d.decision, d.decision])))}</b>
          ${d.proposed ? `<span class="badge info">${tr('Proposta', 'Proposal')}: ${num1(d.proposed.slope)} / ${nf(d.proposed.shift, 0)}</span>` : ''}
          ${d.safety === 'VETO' ? `<span class="badge bad">${d.vetoCode === 'LIMIT_REACHED' ? tr('Limite raggiunto', 'Limit reached') : tr('Bloccato per sicurezza', 'Blocked for safety')}</span>` : d.proposed ? `<span class="badge good">${tr('Controlli superati', 'Safety checks passed')}</span>` : ''}
          ${d.applied ? `<span class="badge good">✓ ${tr('applicata', 'applied')}</span>` : ''}</div>
        <p>${esc(decisionText(d))}</p>
        ${d.stats ? `<div class="rows">
          ${d.proposed || d.vetoCode ? `<div class="row"><span class="k">${tr('Affidabilità', 'Confidence')}</span><span class="v"><span class="bar"><i class="${confLvl}" style="width:${d.confidence}%"></i></span>${d.confidence}% <small class="muted">${C.mode === 'auto' && C.enabled ? tr(`(applicata da sola da ${C.autoConfidence}%)`, `(applied automatically from ${C.autoConfidence}%)`) : ''}</small></span></div>` : ''}
          <div class="row"><span class="k">${tr('Dati usati', 'Data used')}</span><span class="v">${d.stats.samples} ${tr('campioni', 'samples')} · ${Math.round(d.stats.hours)} ${tr('ore', 'h')} · ${tr('accordo', 'agreement')} ${Math.round(d.stats.agreement * 100)}%</span></div>
          <div class="row"><span class="k">${tr('Temperatura esterna', 'Outdoor temperature')}</span><span class="v">${num1(d.stats.outdoorLow)} … ${num1(d.stats.outdoorHigh)} °C (${tr('escursione', 'range')} ${num1(d.stats.outdoorRange)} °C)</span></div>
          <div class="row"><span class="k">${tr('Errore stanza (mediana)', 'Room error (median)')}</span><span class="v">${d.stats.medianRoomError >= 0 ? '+' : ''}${nf(d.stats.medianRoomError, 2)} °C</span></div>
          <div class="row"><span class="k">${tr('Errore col freddo / col mite', 'Error when cold / mild')}</span><span class="v">${nf(d.stats.errorAtLow, 2)} / ${nf(d.stats.errorAtHigh, 2)} °C · R² ${nf(d.stats.r2, 2)}</span></div>
          ${d.flow ? `<div class="row"><span class="k">${tr('Mandata col bruciatore acceso', 'Flow with the burner on')}</span><span class="v ${d.flow.median >= d.flow.limit ? 'bad' : ''}">${tr('mediana', 'median')} ${num1(d.flow.median)} °C · max ${num1(d.flow.max)} °C · ${tr('limite', 'limit')} ${num1(d.flow.limit)} °C${d.flow.expected !== null ? ` · ${tr('curva', 'curve')} ≈ ${num1(d.flow.expected)} °C` : ''}</span></div>` : ''}
        </div>` : ''}
        <div class="muted small">${tr('Valutata il', 'Evaluated on')} ${fmtDT(d.ts)}</div>
      </div>`;
    el.innerHTML = `<h2>${icon('curve')} ${tr('Curva climatica', 'Heating curve')}</h2>
      <p class="intro">${tr('La curva decide quanto scalda la caldaia in base al freddo esterno. Ogni giorno di riscaldamento il plugin confronta la stanza con il programma (fino a 7 giorni di dati) e capisce se va cambiata la pendenza (errore che cresce col freddo) o lo spostamento (errore uguale sempre), a passi di 0,1 o 1. Non alza mai la curva se la mandata è già alta.', 'The curve decides how hard the boiler heats based on the outdoor cold. On every heating day the plugin compares the room with the program (up to 7 days of data) and works out whether the slope (error growing with the cold) or the shift (same error always) needs changing, in steps of 0.1 or 1. It never raises the curve when the flow is already high.')}</p>
      <div class="kpis">
        <div class="kpi"><div class="l">${tr('Curva attuale', 'Current curve')}</div><div class="n">${cur ? `${num1(cur.slope)} / ${nf(cur.shift, 0)}` : (d && d.current ? `${num1(d.current.slope)} / ${nf(d.current.shift, 0)}` : '—')}</div><div class="s muted">${tr('pendenza / spostamento', 'slope / shift')}</div></div>
        <div class="kpi"><div class="l">${tr('Ottimizzazione', 'Optimisation')}</div><div class="n ${C.enabled ? 'good' : 'muted'}">${modeTxt}</div><div class="s muted">${C.enabled ? tr(`ogni ${C.intervalHours} ore, nei giorni di riscaldamento`, `every ${C.intervalHours} h, on heating days`) : tr('attivala nelle impostazioni del plugin', 'turn it on in the plugin settings')}</div></div>
        ${base ? `<div class="kpi"><div class="l">${tr('Curva di partenza', 'Starting curve')}</div><div class="n">${num1(base.slope)} / ${nf(base.shift, 0)}</div><div class="s muted">${tr('limiti', 'limits')} ${num1(base.slope - C.maxSlope)}–${num1(base.slope + C.maxSlope)} / ${nf(base.shift - C.maxShift, 0)}–${nf(base.shift + C.maxShift, 0)}</div></div>` : ''}
      </div>
      ${decBox}
      <div class="btns">
        ${C.enabled ? `<button class="btn" id="cv-check">${tr('Valuta ora', 'Check now')}</button>` : ''}
        ${canApply ? `<button class="btn primary" id="cv-apply">${tr(`Applica ${num1(d.proposed.slope)} / ${nf(d.proposed.shift, 0)}`, `Apply ${num1(d.proposed.slope)} / ${nf(d.proposed.shift, 0)}`)}</button>` : ''}
        ${base && cur && (base.slope !== cur.slope || base.shift !== cur.shift) ? `<button class="btn" id="cv-restore">${tr(`Ripristina la curva di partenza (${num1(base.slope)} / ${nf(base.shift, 0)})`, `Restore the starting curve (${num1(base.slope)} / ${nf(base.shift, 0)})`)}</button>` : ''}
      </div>
      ${hist.length ? `<div class="tw"><table><tr><th>${tr('Quando', 'When')}</th><th>${tr('Da', 'From')}</th><th>${tr('A', 'To')}</th><th>${tr('Affid.', 'Conf.')}</th><th style="text-align:left">${tr('Motivo', 'Reason')}</th></tr>${hist.map((h) => `<tr><td>${fmtDT(h.ts)}</td><td>${num1(h.from.slope)} / ${nf(h.from.shift, 0)}</td><td><b>${num1(h.to.slope)} / ${nf(h.to.shift, 0)}</b></td><td>${h.confidence !== undefined && h.confidence !== null ? h.confidence + '%' : '—'}</td><td style="text-align:left;white-space:normal">${esc(why(h.reason))}${h.auto ? '' : ` <small class="muted">(${tr('manuale', 'manual')})</small>`}</td></tr>`).join('')}</table></div>` : ''}`;
    const run = (id, fn) => { const b = $(id); if (b) b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { toast(tr('Errore: ', 'Error: ') + e.message); } finally { b.disabled = false; } }; };
    run('#cv-check', async () => { S.curve = await api('POST', '/api/curve/check', { installationId: c.installationId, circuit: c.circuit }); renderCurve(); toast(tr('Valutazione aggiornata', 'Evaluation updated')); });
    run('#cv-apply', async () => {
      if (!confirm(tr(`Scrivere sulla caldaia la curva ${num1(d.proposed.slope)} / ${nf(d.proposed.shift, 0)}? I dati vengono ricontrollati prima di applicarla.`, `Write the curve ${num1(d.proposed.slope)} / ${nf(d.proposed.shift, 0)} to the boiler? The data are checked again before applying it.`))) return;
      S.curve = await api('POST', '/api/curve/apply', { installationId: c.installationId, circuit: c.circuit, expected: d.proposed }); renderCurve(); toast(tr('Curva applicata', 'Curve applied')); refresh();
    });
    run('#cv-restore', async () => {
      if (!confirm(tr('Rimettere la curva di partenza sulla caldaia?', 'Put the starting curve back on the boiler?'))) return;
      await api('POST', '/api/curve/restore', { installationId: c.installationId, circuit: c.circuit }); toast(tr('Curva ripristinata', 'Curve restored')); refresh();
    });
  }

  // ── refresh ────────────────────────────────────────────────────────────────
  let formBuilt = false;
  async function refresh() {
    try {
      const j = await api('GET', '/api/status');
      const combChanged = JSON.stringify(j.combustion) !== JSON.stringify(S.combustion);
      S = { ...S, ...j };
      if (j.security) { SEC.pinRequired = !!j.security.pinRequired; SEC.unlocked = !!j.security.unlocked; }
      renderPills(); renderAuth(); renderStatus(); renderSaved(); renderCurve();
      if (!formBuilt) { renderReportForm(); formBuilt = true; }
      $('#report').className = S.auth && S.auth.state !== 'authenticated' ? 'card c7' : 'card';
      if (combChanged && !editing && !$('#comb').contains(document.activeElement)) renderComb();
    } catch (e) { /* server restarting: keep the page */ }
  }
  renderAuth(); renderPills(); renderStatus();
  $('#report').innerHTML = `<p class="empty">${tr('Caricamento…', 'Loading…')}</p>`;
  refresh();
  setInterval(refresh, 30000);
})();
