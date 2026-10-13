/* =============================================================================
   DeepQr scanning engine
   One place that turns every kind of scanner into "a code was scanned":
     * USB / Bluetooth / Android-POS scanners in keyboard mode (fast keystrokes,
       with Enter, Tab or no suffix) — captured from a scan box or anywhere on the page
     * phone / tablet / laptop cameras (back camera chosen automatically,
       camera switcher, torch, continuous scanning with a short cool-down)
   Pages register a handler with Scanner.pushHandler(id, fn); the newest wins.
   ============================================================================= */
const Scanner = (() => {
  let stack = [];
  let buf = '', last = 0, first = 0, timer = null, lastEmit = { code: '', at: 0 };
  let cam = null, camBusy = false, camPaused = false, torchOn = false;
  const log = [];

  const cfg = () => ({
    minLen: Number(lsGet('dq_scan_min') || 5),
    gap: Number(lsGet('dq_scan_gap') || 50),         // max ms between keystrokes from a scanner
    autoSubmit: lsGet('dq_scan_auto') !== '0',       // scanners without Enter/Tab suffix
    cooldown: Number(lsGet('dq_scan_cooldown') || 900)
  });

  function pushHandler(id, fn) { stack = stack.filter(h => h.id !== id); stack.push({ id, fn }); }
  function popHandler(id) { stack = stack.filter(h => h.id !== id); }
  function current() { return stack[stack.length - 1]; }

  function clean(raw) { return String(raw || '').replace(/[\x00-\x1F\x7F]/g, '').trim(); }
  // accepts any separator a keyboard layout produced instead of "|"
  function parse(raw) {
    const t = clean(raw), u = t.toUpperCase();
    let m = u.match(/^DQ1([^A-Z0-9])([A-Z0-9]+)\1(S\d+)\1(.*)\1(\d{9,})$/);
    if (m) return { type: 'qr', biz: m[2], shop: m[3], product: m[4], serial: m[5], sep: m[1], text: t, normalized: `DQ1|${m[2]}|${m[3]}|${m[4]}|${m[5]}` };
    m = u.match(/DQ[^A-Z0-9]1[^A-Z0-9]([A-Z0-9]+)[^A-Z0-9](S\d+)?.*?(\d{9,})[^0-9]*$/);
    if (m && /^HTTPS?[^A-Z0-9]/.test(u)) return { type: 'qr', biz: m[1], shop: m[2], serial: m[3], text: t, normalized: t, link: true };
    m = u.match(/^DQ1[^A-Z0-9]+([A-Z0-9]+)[^A-Z0-9].*?(\d{9,})[^0-9]*$/);
    if (m) return { type: 'qr', biz: m[1], serial: m[2], text: t, normalized: t };
    if (/^\d{9,}$/.test(u)) return { type: 'serial', serial: u, text: t };
    if (/^DQR[^A-Z0-9]/.test(u)) return { type: 'receipt', text: t, receipt: u.split(/[^A-Z0-9-]/)[2] || '' };
    return { type: 'code', text: t };
  }
  function emit(raw, source) {
    const code = clean(raw); if (!code) return;
    const now = Date.now();
    if (code === lastEmit.code && now - lastEmit.at < cfg().cooldown) return;
    lastEmit = { code, at: now };
    const p = parse(code);
    log.unshift({ at: new Date(), raw: String(raw), code, source, parsed: p }); if (log.length > 60) log.length = 60;
    document.dispatchEvent(new CustomEvent('dq-scan', { detail: { code, source, raw, parsed: p } }));
    const h = current(); if (h) { try { h.fn(code, source, p); } catch (e) { console.error(e); } }
  }

  // ---- keyboard wedge, anywhere on the page (no field focused) ----
  document.addEventListener('keydown', e => {
    if (!current()) return;
    const t = e.target, tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || (e.altKey && !e.getModifierState?.('AltGraph'))) return;
    const now = performance.now();
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (buf.length >= cfg().minLen) { e.preventDefault(); const b = buf; buf = ''; clearTimeout(timer); emit(b, 'keyboard'); }
      buf = ''; return;
    }
    if (e.key.length !== 1) return;
    if (now - last > Math.max(cfg().gap, 120)) { buf = ''; first = now; }
    buf += e.key; last = now;
    clearTimeout(timer);
    if (cfg().autoSubmit) timer = setTimeout(() => {
      const avg = (last - first) / Math.max(buf.length - 1, 1);
      if (buf.length >= cfg().minLen && avg <= cfg().gap) { const b = buf; buf = ''; emit(b, 'keyboard'); }
      buf = '';
    }, 140);
  }, true);

  // ---- a dedicated scan box (works with on-screen keyboard, USB, Bluetooth, POS terminals) ----
  function bindInput(el) {
    if (!el || el.__dqBound) return; el.__dqBound = true;
    let t0 = 0, tl = 0, n = 0, tmr = null;
    const fire = () => { const v = el.value; el.value = ''; n = 0; if (clean(v)) emit(v, 'scanbox'); };
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || (e.key === 'Tab' && el.value.length >= cfg().minLen)) { e.preventDefault(); clearTimeout(tmr); fire(); }
    });
    el.addEventListener('input', () => {
      const now = performance.now();
      if (now - tl > 400) { t0 = now; n = 0; }
      n++; tl = now;
      clearTimeout(tmr);
      if (!cfg().autoSubmit) return;
      tmr = setTimeout(() => {
        const avg = (tl - t0) / Math.max(n - 1, 1);
        if (el.value.length >= cfg().minLen && n >= cfg().minLen && avg <= cfg().gap) fire();
      }, 160);
    });
    if (lsGet('dq_scan_hidekb') === '1') el.setAttribute('inputmode', 'none');
  }

  // ---- camera ----
  function camSupported() { return !!window.Html5Qrcode && !!navigator.mediaDevices?.getUserMedia; }
  function result(ok, text) {
    const el = document.getElementById('camResult'); if (!el) return;
    el.className = 'camResult ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); el.textContent = text;
  }
  async function openCamera(opts = {}) {
    modal(`<div class="cardHead"><div><h3>${esc(opts.title || 'Scan with camera')}</h3><p>${esc(opts.hint || 'Hold the QR code inside the square. Each scan is added straight away — keep scanning, then tap Done.')}</p></div><button class="btn ghost" onclick="closeModal()" aria-label="Close">${icon('x')}</button></div>
      <div class="camWrap"><div id="reader"></div><div class="camHud"><div class="camResult" id="camResult">Starting camera…</div><button type="button" id="camTorch" class="btn small hidden" onclick="Scanner.toggleTorch()">${icon('flash')}Torch</button></div></div>
      <div class="toolbar" style="margin-top:10px"><select id="camSelect" class="input grow" aria-label="Camera" onchange="Scanner.startCamera(this.value)"></select><button type="button" class="btn" onclick="Scanner.nextCamera()">${icon('refund')}Switch</button></div>
      <form id="camManual" class="searchLine"><input class="input mono" id="camManualIn" placeholder="Camera not reading? Type the serial (e.g. 202612001)"><button class="btn">Add</button></form>
      <div class="actions" style="justify-content:flex-end"><button class="btn primary lg" onclick="closeModal()">${icon('check')}Done</button></div>`);
    document.getElementById('camManual').onsubmit = (e) => { e.preventDefault(); const i = document.getElementById('camManualIn'); emit(i.value, 'manual'); i.value = ''; };
    if (!window.isSecureContext) { result(false, 'The camera needs a secure (https://) address.'); return; }
    if (!camSupported()) { result(false, 'This browser cannot use the camera. Use a scanner or type the serial.'); return; }
    let cams = [];
    try { cams = await Html5Qrcode.getCameras(); } catch (e) { result(false, 'Camera permission was refused. Allow the camera in the browser settings (padlock icon), then try again.'); return; }
    if (!document.getElementById('camSelect')) return;
    const saved = lsGet('dq_cam_id');
    const back = cams.find(c => /back|rear|environment|arri[eè]re|tras/i.test(c.label || ''));
    const pick = (saved && cams.find(c => c.id === saved)) || back || cams[cams.length - 1];
    document.getElementById('camSelect').innerHTML = cams.map((c, i) => `<option value="${esc(c.id)}" ${pick && c.id === pick.id ? 'selected' : ''}>${esc(c.label || ('Camera ' + (i + 1)))}</option>`).join('') || '<option value="">Default camera</option>';
    await startCamera(pick ? pick.id : '');
  }
  async function startCamera(id) {
    if (camBusy) return; camBusy = true;
    try {
      await stopCamera();
      if (!document.getElementById('reader')) return;
      const F = Html5QrcodeSupportedFormats;
      cam = new Html5Qrcode('reader', { formatsToSupport: [F.QR_CODE, F.CODE_128, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_39], verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
      const conf = { fps: 15, qrbox: (w, h) => { const s = Math.max(150, Math.floor(Math.min(w, h) * 0.8)); return { width: s, height: s }; } };
      const onDecode = (text) => { if (camPaused) return; camPaused = true; emit(text, 'camera'); setTimeout(() => camPaused = false, cfg().cooldown); };
      try {
        await cam.start(id ? id : { facingMode: 'environment' }, conf, onDecode, () => {});
      } catch (e) {
        await cam.start({ facingMode: 'user' }, conf, onDecode, () => {});
      }
      if (id) lsSet('dq_cam_id', id);
      result(null, 'Scanning… hold the code steady in the square');
      torchOn = false;
      try {
        const tf = cam.getRunningTrackCameraCapabilities().torchFeature();
        document.getElementById('camTorch')?.classList.toggle('hidden', !tf.isSupported());
      } catch (e) {}
    } catch (e) {
      result(false, 'Could not start the camera: ' + (e?.message || e) + '. Try another camera or type the serial.');
    } finally { camBusy = false; }
  }
  function nextCamera() {
    const sel = document.getElementById('camSelect'); if (!sel || sel.options.length < 2) return;
    sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length; startCamera(sel.value);
  }
  async function toggleTorch() {
    try { const tf = cam.getRunningTrackCameraCapabilities().torchFeature(); torchOn = !torchOn; await tf.apply(torchOn); } catch (e) { toast('Torch not available on this camera', 'bad'); }
  }
  async function stopCamera() {
    if (!cam) return; const c = cam; cam = null;
    try { if (c.isScanning) await c.stop(); } catch (e) {}
    try { c.clear(); } catch (e) {}
  }

  // ---- feedback shared by every page ----
  function feedback(ok, msg) {
    beep(ok);
    result(ok, msg);
    const z = document.getElementById('scanZone');
    if (z) { z.classList.remove('flash-ok', 'flash-bad'); void z.offsetWidth; z.classList.add(ok ? 'flash-ok' : 'flash-bad'); setTimeout(() => z.classList.remove('flash-ok', 'flash-bad'), 700); }
    const l = document.getElementById('lastScan');
    if (l) l.innerHTML = (ok ? '<span class="ok">✔ </span>' : '<span class="bad">✖ </span>') + esc(msg);
  }

  return { pushHandler, popHandler, parse, clean, emit, bindInput, openCamera, startCamera, nextCamera, toggleTorch, stopCamera, feedback, log, cfg, camSupported };
})();
window.Scanner = Scanner;
