/* ============================================================
   SkpAI — front-end app (runs inside SketchUp's HtmlDialog CEF)
   All fal.ai traffic happens here via fetch(). Ruby only provides
   the viewport capture and file-save bridge (window.sketchup.*).
   ============================================================ */

'use strict';

/* ------------------------------------------------------------------
   fal.ai endpoint IDs.
   These are the model slugs appended to https://queue.fal.run/<id>.
   If fal renames a model, edit the slug here — nothing else changes.
   Verify against your fal dashboard / model page.
------------------------------------------------------------------ */
const FAL = {
  QUEUE_BASE: 'https://queue.fal.run',
  // nano-banana-2 image edit (multi-image: viewport + aesthetic ref)
  RENDER:   'fal-ai/nano-banana-2/edit',
  // Seedance 2 image-to-video
  VIDEO:    'fal-ai/bytedance/seedance/v2/image-to-video',
  // text model used to enhance weak prompts
  LLM:      'fal-ai/any-llm',
  LLM_MODEL: 'google/gemini-flash-1.5',
};

/* Camera-motion presets → prompt fragments for Seedance. */
const MOTION = {
  dolly: {
    label: 'dolly in',
    prompt: 'Slow cinematic dolly-in: the camera smoothly pushes forward ' +
            'toward the subject, subtle parallax, steady architectural ' +
            'walkthrough feel, gentle depth reveal. Photorealistic, stable, no warping.',
    duration: '5',
  },
  timelapse: {
    label: 'timelapse',
    prompt: 'Timelapse from day to dusk: sunlight shifts across the surfaces, ' +
            'soft clouds drift, ambient light warms then cools, long shadows ' +
            'sweep. Camera mostly static, hyperlapse energy. Photorealistic, no warping.',
    duration: '5',
  },
};

/* ------------------------------------------------------------------ state */
const state = {
  apiKey: '',
  viewport: null,   // data URI of captured viewport
  reference: null,  // data URI of aesthetic reference
  render: null,     // hosted URL of nb2 result
  renderData: null, // data URI of render (for local save)
  video: null,      // hosted URL of seedance result
  motion: 'dolly',
  scenes: [],       // [{index, name}] from the model
  busy: false,
};

/* ------------------------------------------------------------------ dom */
const $ = (id) => document.getElementById(id);
const el = {
  led: $('led'), statusText: $('statusText'), log: $('log'),
  apiKey: $('apiKey'), keyToggle: $('keyToggle'), saveKey: $('saveKey'),
  captureBtn: $('captureBtn'), sourcePreview: $('sourcePreview'), sourceImg: $('sourceImg'),
  prompt: $('prompt'), enhanceBtn: $('enhanceBtn'),
  promptMeter: $('promptMeter'), promptWords: $('promptWords'),
  dropzone: $('dropzone'), refInput: $('refInput'), refImg: $('refImg'),
  refEmpty: $('refEmpty'), clearRef: $('clearRef'),
  renderBtn: $('renderBtn'), renderPreview: $('renderPreview'), renderImg: $('renderImg'),
  saveRender: $('saveRender'),
  motionSeg: $('motionSeg'),
  videoBtn: $('videoBtn'), videoPreview: $('videoPreview'), videoEl: $('videoEl'),
  saveVideo: $('saveVideo'),
  scanBtn: $('scanBtn'), sceneCount: $('sceneCount'), batchProgress: $('batchProgress'),
  batchBtn: $('batchBtn'), gallery: $('gallery'),
  clearLog: $('clearLog'),
};

/* Ruby callbacks that JS needs to await are turned into promises here:
   a caller stores a resolver under a key, the SkpAI.* bridge resolves it. */
const waiters = {};
function rubyAwait(key) { return new Promise((res) => { waiters[key] = res; }); }
function rubyResolve(key, val) {
  const r = waiters[key];
  if (r) { delete waiters[key]; r(val); }
}

/* ------------------------------------------------------------------ util */
function log(msg, cls) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const line = document.createElement('span');
  line.innerHTML = `<span class="l-time">${hh}:${mm}:${ss}</span> ` +
                   `<span class="${cls || ''}">${escapeHtml(msg)}</span>\n`;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function setStatus(text, mode) {
  el.statusText.textContent = text;
  el.led.className = 'led led--' + (mode || 'idle');
}
function setBusy(on, text) {
  state.busy = on;
  setStatus(text || (on ? 'working' : 'idle'), on ? 'busy' : 'idle');
  [el.captureBtn, el.renderBtn, el.videoBtn, el.enhanceBtn, el.scanBtn, el.batchBtn].forEach((b) => {
    if (!b) return;
    if (on) b.dataset.wasDisabled = b.disabled ? '1' : '0';
    b.disabled = on ? true : (b.dataset.wasDisabled === '1');
  });
  refreshButtons();
}
function callRuby(name, ...args) {
  if (window.sketchup && typeof window.sketchup[name] === 'function') {
    window.sketchup[name](...args);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ Ruby → JS bridge */
window.SkpAI = {
  onViewport(dataUri) {
    state.viewport = dataUri;
    el.sourceImg.src = dataUri;
    el.sourceImg.hidden = false;
    el.sourcePreview.querySelector('.preview-empty').style.display = 'none';
    log('viewport captured', 'l-ok');
    setBusy(false);
    refreshButtons();
  },
  onError(msg) {
    log(msg, 'l-err');
    setStatus('error', 'err');
    setBusy(false);
  },
  onSaved(path) { if (path) log('saved → ' + path, 'l-ok'); },
  onPref(key, val) {
    if (key === 'fal_key' && val && !state.apiKey) {
      state.apiKey = val; el.apiKey.value = val;
      log('api key restored from SketchUp defaults', 'l-time');
    }
  },
  onScenes(scenes) {
    state.scenes = scenes || [];
    const n = state.scenes.length;
    el.sceneCount.textContent = n ? `${n} scene${n > 1 ? 's' : ''}` : 'no scenes';
    if (!n) log('no scenes in model — create scenes in SketchUp first', 'l-warn');
    else log(`found ${n} scene${n > 1 ? 's' : ''}`, 'l-ok');
    rubyResolve('scenes', state.scenes);
    refreshButtons();
  },
  onBatchReady() { rubyResolve('batch'); },
  onSceneCapture(index, name, dataUri) { rubyResolve('scene', { index, name, dataUri }); },
};

/* ------------------------------------------------------------------ fal.ai queue runner */
async function falRun(endpoint, input, { onProgress } = {}) {
  if (!state.apiKey) throw new Error('No fal.ai API key — set it in module 00.');
  const headers = {
    'Authorization': 'Key ' + state.apiKey,
    'Content-Type': 'application/json',
  };

  // 1) submit to the queue
  const submit = await fetch(`${FAL.QUEUE_BASE}/${endpoint}`, {
    method: 'POST', headers, body: JSON.stringify(input),
  });
  if (!submit.ok) throw new Error(`submit ${submit.status}: ${await safeText(submit)}`);
  const job = await submit.json();
  const statusUrl = job.status_url;
  const responseUrl = job.response_url;
  if (!statusUrl || !responseUrl) throw new Error('fal: missing status/response url');

  // 2) poll until completed
  let seenLogs = 0;
  const started = performance.now();
  const TIMEOUT_MS = 6 * 60 * 1000;
  for (;;) {
    if (performance.now() - started > TIMEOUT_MS) throw new Error('fal: timed out');
    await sleep(1600);
    const st = await fetch(`${statusUrl}?logs=1`, { headers });
    if (!st.ok) throw new Error(`status ${st.status}: ${await safeText(st)}`);
    const s = await st.json();

    if (Array.isArray(s.logs) && s.logs.length > seenLogs) {
      s.logs.slice(seenLogs).forEach((l) => l && l.message && log('· ' + l.message, 'l-time'));
      seenLogs = s.logs.length;
    }
    if (onProgress) onProgress(s);
    if (s.status === 'COMPLETED') break;
    if (s.status === 'FAILED' || s.status === 'ERROR')
      throw new Error('fal: job failed');
  }

  // 3) fetch the result
  const res = await fetch(responseUrl, { headers });
  if (!res.ok) throw new Error(`result ${res.status}: ${await safeText(res)}`);
  return res.json();
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function safeText(r) { try { return (await r.text()).slice(0, 300); } catch { return ''; } }

/* ------------------------------------------------------------------ prompt strength */
function scorePrompt(text) {
  const words = (text.trim().match(/\S+/g) || []).length;
  // heuristic: reward descriptive tokens (materials, light, lens, mood)
  const rich = /(light|dusk|dawn|sunset|golden|material|concrete|wood|glass|steel|marble|lens|mm|cinematic|photoreal|render|mood|fog|shadow|reflection|ambient|studio|overcast)/i;
  const hits = (text.match(new RegExp(rich, 'gi')) || []).length;
  const score = Math.min(100, words * 6 + hits * 10);
  return { words, score };
}
function refreshMeter() {
  const { words, score } = scorePrompt(el.prompt.value);
  el.promptWords.textContent = words + 'w';
  el.promptMeter.style.width = score + '%';
  el.promptMeter.style.background =
    score < 35 ? 'var(--led-red)' : score < 70 ? 'var(--led-amber)' : 'var(--led-green)';
}
function isWeak() { return scorePrompt(el.prompt.value).score < 40; }

/* ------------------------------------------------------------------ enhance */
async function enhancePrompt() {
  const raw = el.prompt.value.trim();
  if (!raw) { log('nothing to enhance — type a brief first', 'l-warn'); return null; }
  setBusy(true, 'enhancing');
  log('enhancing prompt…', 'l-acc');
  try {
    const sys = 'You are a prompt engineer for architectural & product ' +
      'visualization diffusion renders. Rewrite the user brief into ONE vivid, ' +
      'concrete prompt under 70 words. Add concrete materials, lighting, time of ' +
      'day, camera/lens, mood and photoreal render descriptors while keeping the ' +
      "user's subject and intent. Output ONLY the prompt text, no preamble, no quotes.";
    const out = await falRun(FAL.LLM, {
      model: FAL.LLM_MODEL,
      system_prompt: sys,
      prompt: raw,
    });
    const enhanced = (out.output || out.text || '').trim();
    if (!enhanced) throw new Error('empty response');
    el.prompt.value = enhanced;
    refreshMeter();
    log('prompt enhanced ✧', 'l-ok');
    setBusy(false);
    return enhanced;
  } catch (e) {
    log('enhance failed: ' + e.message, 'l-err');
    setStatus('error', 'err');
    setBusy(false);
    return null;
  }
}

/* ------------------------------------------------------------------ render (nb2) */
async function doRender() {
  if (!state.viewport) { log('capture the viewport first (01)', 'l-warn'); return; }
  if (!el.prompt.value.trim()) { log('enter a prompt (02)', 'l-warn'); return; }

  // auto-enhance a weak prompt before spending a render
  if (isWeak()) {
    log('weak prompt detected — auto-enhancing first', 'l-warn');
    const enhanced = await enhancePrompt();
    if (!enhanced) return;
  }

  setBusy(true, 'rendering');
  log('render → nano-banana-2', 'l-acc');
  try {
    const images = [state.viewport];
    if (state.reference) {
      images.push(state.reference);
      log('· using aesthetic reference for material match', 'l-time');
    }
    const promptText = el.prompt.value.trim() + (state.reference
      ? ' Match the materials, palette and mood of the reference image while keeping the exact geometry and composition of the first image.'
      : ' Keep the exact geometry and composition of the input image.');

    const out = await falRun(FAL.RENDER, {
      prompt: promptText,
      image_urls: images,
      num_images: 1,
    });

    const url = pickImage(out);
    if (!url) throw new Error('no image in response');
    state.render = url;
    el.renderImg.src = url;
    el.renderImg.hidden = false;
    el.renderPreview.querySelector('.preview-empty').style.display = 'none';
    // cache a data URI copy for local saving
    state.renderData = await urlToDataUri(url).catch(() => null);
    log('render complete', 'l-ok');
    setStatus('done', 'ok');
    setBusy(false);
    refreshButtons();
  } catch (e) {
    log('render failed: ' + e.message, 'l-err');
    setStatus('error', 'err');
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ video (seedance) */
async function doVideo() {
  if (!state.render) { log('render a still first (04)', 'l-warn'); return; }
  const m = MOTION[state.motion];
  setBusy(true, 'animating');
  log(`video → seedance 2 · ${m.label}`, 'l-acc');
  try {
    const base = el.prompt.value.trim();
    const out = await falRun(FAL.VIDEO, {
      prompt: `${base}. ${m.prompt}`,
      image_url: state.render,
      duration: m.duration,
      resolution: '1080p',
    });
    const url = pickVideo(out);
    if (!url) throw new Error('no video in response');
    state.video = url;
    el.videoEl.src = url;
    el.videoEl.hidden = false;
    el.videoPreview.querySelector('.preview-empty').style.display = 'none';
    el.videoEl.play().catch(() => {});
    log('video complete', 'l-ok');
    setStatus('done', 'ok');
    setBusy(false);
    refreshButtons();
  } catch (e) {
    log('video failed: ' + e.message, 'l-err');
    setStatus('error', 'err');
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ batch: all scenes */
function scanScenes() {
  if (!callRuby('list_scenes')) {
    log('SketchUp bridge unavailable (open inside SketchUp)', 'l-err');
    return;
  }
  log('scanning scenes…', 'l-acc');
}

async function batchRender() {
  if (!state.scenes.length) { log('scan for scenes first', 'l-warn'); return; }
  if (!el.prompt.value.trim()) { log('enter a prompt (02)', 'l-warn'); return; }
  if (!state.apiKey) { log('set your fal.ai key (00)', 'l-warn'); return; }

  // enhance once up front so every scene shares the strong prompt
  if (isWeak()) {
    log('weak prompt — enhancing once before the batch', 'l-warn');
    const enhanced = await enhancePrompt();
    if (!enhanced) return;
  }

  setBusy(true, 'batch render');
  el.gallery.hidden = false;
  el.gallery.innerHTML = '';
  const total = state.scenes.length;
  const refNote = state.reference
    ? ' Match the materials, palette and mood of the reference image while keeping the exact geometry and composition of the first image.'
    : ' Keep the exact geometry and composition of the input image.';
  const basePrompt = el.prompt.value.trim() + refNote;

  try {
    await new Promise((res) => { callRuby('batch_begin'); rubyAwait('batch').then(res); });

    for (let i = 0; i < total; i++) {
      el.batchProgress.textContent = `${i + 1}/${total}`;
      setStatus(`scene ${i + 1}/${total}`, 'busy');

      // capture this scene from SketchUp
      callRuby('capture_scene', state.scenes[i].index);
      const cap = await rubyAwait('scene');
      const cell = addCell(cap.name || `Scene ${i + 1}`);
      if (!cap.dataUri) { failCell(cell, 'capture failed'); log(`· ${cap.name}: capture failed`, 'l-warn'); continue; }

      // render it
      try {
        const images = state.reference ? [cap.dataUri, state.reference] : [cap.dataUri];
        const out = await falRun(FAL.RENDER, { prompt: basePrompt, image_urls: images, num_images: 1 });
        const url = pickImage(out);
        if (!url) throw new Error('no image');
        fillCell(cell, url, cap.name);
        log(`· ${cap.name} ✓`, 'l-ok');
      } catch (e) {
        failCell(cell, 'render failed');
        log(`· ${cap.name}: ${e.message}`, 'l-err');
      }
    }

    callRuby('batch_end');
    log(`batch complete · ${total} scene${total > 1 ? 's' : ''}`, 'l-ok');
    setStatus('done', 'ok');
  } catch (e) {
    callRuby('batch_end');
    log('batch failed: ' + e.message, 'l-err');
    setStatus('error', 'err');
  } finally {
    el.batchProgress.textContent = '';
    setBusy(false);
    refreshButtons();
  }
}

function addCell(name) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.innerHTML =
    `<div class="cell-thumb"><span class="cell-spin">rendering…</span></div>` +
    `<div class="cell-bar"><span class="cell-name">${escapeHtml(name)}</span>` +
    `<span class="cell-acts"></span></div>`;
  el.gallery.appendChild(cell);
  return cell;
}
function fillCell(cell, url, name) {
  const thumb = cell.querySelector('.cell-thumb');
  thumb.innerHTML = `<img alt="${escapeHtml(name)}" src="${url}">`;
  const acts = cell.querySelector('.cell-acts');
  // → send to module 05 as the current render for video
  const toVideo = iconBtn('→', 'use for video');
  toVideo.onclick = () => useAsRender(url, name);
  // save png
  const save = iconBtn('↓', 'save png');
  save.onclick = async () => {
    const data = await urlToDataUri(url).catch(() => null);
    if (data) callRuby('save_data_url', `skpai_${slug(name)}.png`, data);
    else callRuby('open_url', url);
  };
  acts.append(toVideo, save);
}
function failCell(cell, msg) {
  cell.classList.add('err');
  cell.querySelector('.cell-thumb').innerHTML = `<span class="cell-spin">${escapeHtml(msg)}</span>`;
}
function iconBtn(label, title) {
  const b = document.createElement('button');
  b.className = 'icon-btn'; b.textContent = label; b.title = title;
  return b;
}
function useAsRender(url, name) {
  state.render = url;
  state.renderData = null;
  el.renderImg.src = url; el.renderImg.hidden = false;
  el.renderPreview.querySelector('.preview-empty').style.display = 'none';
  urlToDataUri(url).then((d) => { state.renderData = d; }).catch(() => {});
  log(`“${name}” → ready for video (05)`, 'l-acc');
  refreshButtons();
  el.videoBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'scene'; }

/* ------------------------------------------------------------------ response pickers */
function pickImage(o) {
  if (!o) return null;
  if (Array.isArray(o.images) && o.images[0]) return o.images[0].url || o.images[0];
  if (o.image) return o.image.url || o.image;
  return null;
}
function pickVideo(o) {
  if (!o) return null;
  if (o.video) return o.video.url || o.video;
  if (Array.isArray(o.videos) && o.videos[0]) return o.videos[0].url || o.videos[0];
  return null;
}
async function urlToDataUri(url) {
  const r = await fetch(url);
  const blob = await r.blob();
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ button gating */
function refreshButtons() {
  if (state.busy) return;
  el.saveRender.disabled = !state.render;
  el.videoBtn.disabled = !state.render;
  el.saveVideo.disabled = !state.video;
  el.captureBtn.disabled = false;
  el.renderBtn.disabled = false;
  el.enhanceBtn.disabled = false;
  el.scanBtn.disabled = false;
  el.batchBtn.disabled = !state.scenes.length;
}

/* ------------------------------------------------------------------ reference image */
function loadReference(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const fr = new FileReader();
  fr.onload = () => {
    state.reference = fr.result;
    el.refImg.src = fr.result;
    el.refImg.hidden = false;
    el.refEmpty.style.display = 'none';
    el.clearRef.hidden = false;
    log('aesthetic reference loaded', 'l-ok');
  };
  fr.readAsDataURL(file);
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  // --- api key ---
  el.saveKey.addEventListener('click', () => {
    state.apiKey = el.apiKey.value.trim();
    try { localStorage.setItem('skpai_fal_key', state.apiKey); } catch {}
    callRuby('store_pref', 'fal_key', state.apiKey);
    log(state.apiKey ? 'api key saved' : 'api key cleared',
        state.apiKey ? 'l-ok' : 'l-warn');
  });
  el.keyToggle.addEventListener('click', () => {
    const show = el.apiKey.type === 'password';
    el.apiKey.type = show ? 'text' : 'password';
    el.keyToggle.textContent = show ? 'hide' : 'show';
  });

  // --- capture ---
  el.captureBtn.addEventListener('click', () => {
    if (!callRuby('capture_viewport')) {
      log('SketchUp bridge unavailable (open inside SketchUp)', 'l-err');
      return;
    }
    setBusy(true, 'capturing');
    log('requesting viewport…', 'l-acc');
  });

  // --- prompt / enhance ---
  el.prompt.addEventListener('input', refreshMeter);
  el.enhanceBtn.addEventListener('click', enhancePrompt);

  // --- reference drag/drop + file ---
  el.refInput.addEventListener('change', (e) => loadReference(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove('dragover'); }));
  el.dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadReference(f);
  });
  el.clearRef.addEventListener('click', (e) => {
    e.preventDefault();
    state.reference = null;
    el.refImg.hidden = true; el.refInput.value = '';
    el.refEmpty.style.display = ''; el.clearRef.hidden = true;
    log('reference cleared', 'l-time');
  });

  // --- render / video ---
  el.renderBtn.addEventListener('click', doRender);
  el.videoBtn.addEventListener('click', doVideo);

  // --- batch scenes ---
  el.scanBtn.addEventListener('click', scanScenes);
  el.batchBtn.addEventListener('click', batchRender);

  // --- motion segmented ---
  el.motionSeg.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', () => {
      el.motionSeg.querySelectorAll('.seg').forEach((s) => s.classList.remove('seg--on'));
      seg.classList.add('seg--on');
      state.motion = seg.dataset.motion;
      log('motion → ' + MOTION[state.motion].label, 'l-time');
    });
  });

  // --- saves ---
  el.saveRender.addEventListener('click', () => {
    const data = state.renderData;
    if (data) { callRuby('save_data_url', 'skpai_render.png', data); }
    else if (state.render) { callRuby('open_url', state.render); }
  });
  el.saveVideo.addEventListener('click', () => {
    if (state.video) callRuby('open_url', state.video);
  });

  // --- console ---
  el.clearLog.addEventListener('click', () => { el.log.innerHTML = ''; });
}

/* ------------------------------------------------------------------ init */
function init() {
  wire();
  try {
    const k = localStorage.getItem('skpai_fal_key');
    if (k) { state.apiKey = k; el.apiKey.value = k; }
  } catch {}
  callRuby('read_pref', 'fal_key'); // fall back to SketchUp defaults
  refreshMeter();
  refreshButtons();
  log('SkpAI ready · nano-banana-2 + seedance 2', 'l-acc');
  if (!window.sketchup) log('note: SketchUp bridge not detected (preview mode)', 'l-warn');
}

document.addEventListener('DOMContentLoaded', init);
