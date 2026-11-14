/* Editor page for the Repeat Playlist extension. Pure helpers live in core.js. */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var LEGACY_ROWS = 'rpp.rows.v2', LEGACY_TITLES = 'rpp.titles.v1';
  var DEFAULT_PLAN = 'q-ZCXjbMJ34, 3, 1.0  # example video, three times';

  var rows = [], uidCounter = 1;
  var cur = { uid: null, rep: 1 }, started = false;   // kept so the shared list code can highlight a playing row (unused here)
  var titles = {}, titleFetchBroken = false;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function say(el, text, cls) { el.textContent = text; el.className = 'msg' + (cls ? ' ' + cls : ''); }
  function saveLocal(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function loadLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function fmt(s) { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  // ---------- saved lists: kept on this device and mirrored to the browser's sync storage ----------
  var api = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  var hasExt = !!(api && api.storage && api.storage.local);
  var syncArea = (api && api.storage && api.storage.sync) || null;
  var hasSync = !!syncArea, nativeMode = false, icloudOff = false;
  // Safari: the native app extension keeps the lists in iCloud (key-value store), which syncs Mac and iPhone.
  function nativeCall(msg) {
    return Promise.resolve(api.runtime.sendNativeMessage('application.id', msg));
  }
  function nativeArea() {
    function all() { return nativeCall({ cmd: 'get' }).then(function (r) { if (!r || !r.ok) throw new Error('iCloud read failed'); try { return r.data ? JSON.parse(r.data) : {}; } catch (e) { return {}; } }); }
    function put(o) { return nativeCall({ cmd: 'set', data: JSON.stringify(o) }).then(function (r) { if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'iCloud write failed'); }); }
    return {
      get: function () { return all(); },
      set: function (o) { return all().then(function (cur) { Object.keys(o).forEach(function (k) { cur[k] = o[k]; }); return put(cur); }); },
      remove: function (keys) { return all().then(function (cur) { keys.forEach(function (k) { delete cur[k]; }); return put(cur); }); }
    };
  }
  function setupNative() {
    if (!api || !api.runtime || typeof api.runtime.sendNativeMessage !== 'function') return Promise.resolve();
    return nativeCall({ cmd: 'ping' }).then(function (r) {
      if (!r || !r.ok) return;
      if (r.icloud) { syncArea = nativeArea(); hasSync = true; nativeMode = true; syncState = 'checking'; }
      else { icloudOff = true; }
    }).catch(function () {});
  }
  var LOCAL_STORE = 'rpp:store', LOCAL_ACTIVE = 'rpp:active', LOCAL_TITLES = 'rpp:titles';
  var CHUNK = 4000;   // sync storage allows 8 KB per item, counted after JSON escaping
  var store = emptyStore(), activeId = null, syncState = hasSync ? 'checking' : 'local', titlesDirty = false;

  function localGet(k) {
    if (hasExt) return api.storage.local.get(k).then(function (o) { return o[k]; });
    return Promise.resolve().then(function () { try { var v = localStorage.getItem(k); return v == null ? undefined : JSON.parse(v); } catch (e) { return undefined; } });
  }
  function localSet(k, v) {
    if (hasExt) { var o = {}; o[k] = v; return api.storage.local.set(o); }
    return Promise.resolve().then(function () { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} });
  }
  function activeList() { return store.lists.find(function (l) { return l.id === activeId; }) || null; }

  function makeRow(o) {
    return {
      uid: uidCounter++, id: o.id, on: o.on !== false,
      title: o.title || titles[o.id] || '',
      repeats: o.repeats || 1, speed: o.speed || 1,
      start: o.start || '', end: o.end || ''
    };
  }
  // Called after every edit. Writes nothing until the saved text of the list actually changes.
  function persist() {
    var L = activeList();
    if (L) {
      var d = encodeRows(rows);
      if (d !== L.data) { L.data = d; L.updated = Date.now(); scheduleSave(); }
    }
    updateSummary();
  }

  var saveTimer = null, flushing = false, again = false;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 700); }
  function flush() {
    if (flushing) { again = true; return Promise.resolve(); }
    flushing = true;
    var wantTitles = titlesDirty, snapshot = null;
    titlesDirty = false;
    // Merge in anything another device saved first, so an older copy here never overwrites a newer one there.
    var p = hasSync
      ? readRemote().then(function (remote) { if (applyRemote(remote)) say($('#syncMsg'), 'Updated from another device.', 'good'); }, function () {})
      : Promise.resolve();
    p = p.then(function () { snapshot = JSON.parse(JSON.stringify(store)); return localSet(LOCAL_STORE, snapshot); })
         .then(function () { return localSet(LOCAL_ACTIVE, activeId); });
    if (wantTitles) p = p.then(function () { return localSet(LOCAL_TITLES, titles); });
    if (hasSync) p = p.then(function () { return writeRemote(snapshot); }).then(function () { syncState = 'synced'; }, function (err) { syncState = /quota/i.test(String(err && err.message)) ? 'quota' : 'error'; });
    return p.catch(function () {}).then(function () {
      flushing = false;
      if (syncState !== 'synced' || !$('#syncMsg').textContent || /^Saved|Checking|Saved on/.test($('#syncMsg').textContent)) renderSyncStatus();
      if (again) { again = false; scheduleSave(); }
    });
  }
  // Brings a copy read from sync storage into the live store; true if anything changed on screen.
  function applyRemote(remote) {
    var before = JSON.stringify(mergeStores(store, null)), merged = mergeStores(store, remote);
    if (JSON.stringify(merged) === before) return false;
    store = merged; ensureActive();
    var L = activeList();
    if (encodeRows(rows) !== L.data) { rows = decodeRows(L.data).map(makeRow); renderRows(); }
    applySettings(); renderListUI();
    return true;
  }
  function readRemote() {
    return syncArea.get(null).then(function (all) {
      var groups = {}, meta = all['rpp:meta'] || {};
      Object.keys(all).forEach(function (k) {
        var m = k.match(/^rpp:l:([^:]+):(\d+)$/);
        if (!m) return;
        if (!groups[m[1]]) groups[m[1]] = [];
        groups[m[1]][Number(m[2])] = all[k];
      });
      var lists = [];
      Object.keys(groups).forEach(function (id) {
        var parts = groups[id];
        for (var i = 0; i < parts.length; i++) if (typeof parts[i] !== 'string') return;   // pieces still arriving
        var L = payloadToList(id, parts.join(''));
        if (L) lists.push(L);
      });
      return { v: 1, lists: lists, deleted: meta.deleted || {}, channels: meta.channels || [] };
    });
  }
  function writeRemote(S) {
    var desired = {};
    S.lists.forEach(function (L) {
      chunkString(listToPayload(L), CHUNK).forEach(function (c, i) { desired['rpp:l:' + L.id + ':' + i] = c; });
    });
    desired['rpp:meta'] = { deleted: S.deleted, channels: S.channels };
    return syncArea.get(null).then(function (existing) {
      var toSet = {}, toRemove = [];
      Object.keys(desired).forEach(function (k) { if (JSON.stringify(existing[k]) !== JSON.stringify(desired[k])) toSet[k] = desired[k]; });
      Object.keys(existing).forEach(function (k) { if (k.indexOf('rpp:') === 0 && !(k in desired)) toRemove.push(k); });
      var p = Object.keys(toSet).length ? syncArea.set(toSet) : Promise.resolve();
      return p.then(function () { return toRemove.length ? syncArea.remove(toRemove) : null; });
    });
  }
  function renderSyncStatus() {
    var m = {
      checking: 'Checking sync...',
      synced: nativeMode ? 'Saved. Your lists sync between your devices through iCloud.' : 'Saved. Your lists sync through your browser account (keep sync turned on for extensions or add-ons).',
      local: icloudOff ? 'Saved on this device only. iCloud is not available here: sign in to iCloud and make sure iCloud Key-Value storage is enabled for the app.' : 'Saved on this device only. This browser has no sync storage.',
      quota: 'Saved on this device, but the browser’s sync storage is full. Delete old lists to sync again.',
      error: 'Saved on this device. Syncing failed and will retry on the next change.'
    };
    var bad = syncState === 'quota' || syncState === 'error';
    $('#syncBadge').textContent = bad ? '⚠ sync' : ''; $('#syncBadge').title = bad ? (m[syncState] || '') : '';
    var el2 = $('#syncMsg'); if (el2) say(el2, m[syncState] || '', syncState === 'synced' || syncState === 'local' ? '' : (syncState === 'checking' ? '' : 'bad'));
  }

  function queue() { return rows.filter(function (r) { return r.on && !validateRow(r); }); }
  function updateSummary() {
    var q = queue(), plays = q.reduce(function (a, r) { return a + Number(r.repeats); }, 0);
    var bad = rows.filter(function (r) { return r.on && validateRow(r); }).length;
    $('#summary').textContent = rows.length + ' videos, ' + q.length + ' selected, ' + plays + ' plays in total' +
      (bad ? '. ' + bad + ' selected video(s) have invalid values and will be skipped.' : '.');
  }

  // ---------- list editor ----------
  var dragUid = null;
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') n.textContent = props[k]; else if (k === 'class') n.className = props[k]; else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function field(label, input) { var l = el('label', { 'class': 'field', text: label }); l.appendChild(input); return l; }
  function textInput(value, ph, onChange) {
    var i = el('input', { type: 'text', placeholder: ph, autocomplete: 'off' });
    i.value = value;
    i.addEventListener('input', function () { onChange(i); });
    return i;
  }

  // Compact stepper: type a value, or use the up/down triangles (click steps once, press and hold repeats).
  var holdT1 = null, holdT2 = null;
  function stopHold() { clearTimeout(holdT1); clearInterval(holdT2); holdT1 = holdT2 = null; }
  document.addEventListener('pointerup', stopHold);
  document.addEventListener('pointercancel', stopHold);
  function makeStepper(o) {
    var v = o.value, root = el('div', { 'class': 'step' });
    var val = el('input', { type: 'text', 'class': 'val', inputmode: 'decimal', autocomplete: 'off', 'aria-label': o.label + ' (type a value or use the arrows)' });
    var up = el('button', { type: 'button', text: '▲', title: 'Increase ' + o.label.toLowerCase(), 'aria-label': 'Increase ' + o.label.toLowerCase() });
    var dn = el('button', { type: 'button', text: '▼', title: 'Decrease ' + o.label.toLowerCase(), 'aria-label': 'Decrease ' + o.label.toLowerCase() });
    function clamp(x) { x = Math.round(x * 100) / 100; return Math.min(o.max, Math.max(o.min, x)); }
    v = isFinite(v) ? clamp(v) : o.min;
    function paint() { val.value = o.fmt(v); up.disabled = v >= o.max; dn.disabled = v <= o.min; }
    function commitTyped() {
      var x = parseFloat(String(val.value).replace(/[^0-9.]/g, ''));
      if (!isFinite(x)) { paint(); return; }
      var nv = clamp(o.step >= 1 ? Math.round(x) : x);
      if (nv !== v) { v = nv; if (o.onChange) o.onChange(v); }
      paint();
    }
    val.addEventListener('focus', function () { val.select(); });
    val.addEventListener('change', commitTyped);
    val.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { commitTyped(); val.blur(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); bump(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); }
    });
    function bump(dir) {
      var nv = clamp(v + dir * o.step);
      if (nv === v) return false;
      v = nv; paint(); if (o.onChange) o.onChange(v);
      return true;
    }
    function hook(btn, dir) {
      btn.addEventListener('pointerdown', function (e) {
        if (e.button > 0) return;
        e.preventDefault(); stopHold();
        bump(dir);
        holdT1 = setTimeout(function () { holdT2 = setInterval(function () { if (!bump(dir)) stopHold(); }, 90); }, 400);
      });
      btn.addEventListener('click', function (e) { if (e.detail === 0) bump(dir); }); // keyboard
    }
    hook(up, 1); hook(dn, -1);
    if (o.cap) root.appendChild(el('span', { 'class': 'cap', text: o.label }));
    if (o.w) val.style.width = o.w;
    root.appendChild(val);
    root.appendChild(el('span', { 'class': 'arrows' }, [up, dn]));
    paint();
    return { el: root, get: function () { return v; }, set: function (x) { v = clamp(x); paint(); } };
  }
  function repeatsStepper(value, onChange, cap) { return makeStepper({ cap: cap, w: '2.6ch', label: 'Repeat', value: value, min: 1, max: 999, step: 1, fmt: function (x) { return String(x); }, onChange: onChange }); }
  function speedStepper(value, onChange, cap) { return makeStepper({ cap: cap, w: '4.2ch', label: 'Speed', value: value, min: 0.25, max: 4, step: 0.25, fmt: function (x) { return x + '×'; }, onChange: onChange }); }

  function revalidate(r, rowEl) {
    var err = validateRow(r);
    rowEl.querySelectorAll('.step,input[type=text]').forEach(function (i) { i.classList.toggle('bad', !!err); });
    rowEl.title = err || '';
    updateSummary();
  }
  var showRange = false;
  function rangeAuto() { return rows.some(function (r) { return r.start || r.end; }); }
  function paintRange() {
    var on = showRange || rangeAuto();
    $('#grid').classList.toggle('show-range', on);
    $('#toggleRange').classList.toggle('on', on);
    $('#toggleRange').setAttribute('aria-pressed', String(on));
  }
  $('#toggleRange').addEventListener('click', function () { showRange = !showRange; paintRange(); });
  $('#toggleTools').addEventListener('click', function () {
    var t = $('#tools'); t.classList.toggle('hidden'); this.setAttribute('aria-expanded', String(!t.classList.contains('hidden'))); this.classList.toggle('on', !t.classList.contains('hidden'));
  });

  function dropIndex(i, e, tr) {
    var box = tr.getBoundingClientRect(), below = e.clientY > box.top + box.height / 2;
    return { below: below, to: below ? i + 1 : i };
  }
  function clearDrop() { document.querySelectorAll('#rows .drop-above,#rows .drop-below,#rows .dragging').forEach(function (n) { n.classList.remove('drop-above', 'drop-below', 'dragging'); }); }
  function moveRow(from, to, focusUid) {
    if (from < 0 || from === to) return;
    rows = moveItem(rows, from, to); persist(); renderRows();
    if (focusUid != null) { var h = document.querySelector('#rows tr[data-uid="' + focusUid + '"] .handle'); if (h) h.focus(); }
  }

  function renderRows() {
    var tb = $('#rows');
    tb.innerHTML = '';
    rows.forEach(function (r, i) {
      var tr = el('tr', { 'class': 'row' + (r.on ? '' : ' off'), 'data-uid': r.uid });
      function td(cls, kid) { var c = el('td', { 'class': cls || '' }); if (kid) (Array.isArray(kid) ? kid : [kid]).forEach(function (k) { c.appendChild(k); }); tr.appendChild(c); return c; }
      function mini(txt, tip, fn, cls) { var bt = el('button', { type: 'button', 'class': cls || '', text: txt, title: tip, 'aria-label': tip }); bt.addEventListener('click', fn); return bt; }

      var cb = el('input', { type: 'checkbox', 'aria-label': 'Include video ' + (i + 1) });
      cb.checked = r.on;
      cb.addEventListener('change', function () { r.on = cb.checked; tr.classList.toggle('off', !r.on); syncAllCb(); persist(); });
      td('c', cb);

      var handle = el('span', { 'class': 'handle', text: '⠿', title: 'Drag to reorder (or Alt+Up / Alt+Down)', draggable: 'true', tabindex: '0', role: 'button', 'aria-label': 'Reorder video ' + (i + 1) + ' (Alt+Up or Alt+Down)' });
      handle.addEventListener('dragstart', function (e) {
        dragUid = r.uid; tr.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', String(r.uid)); e.dataTransfer.effectAllowed = 'move'; if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(tr, 10, 10); } catch (x) {}
      });
      handle.addEventListener('dragend', function () { dragUid = null; clearDrop(); });
      handle.addEventListener('keydown', function (e) {
        if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveRow(i, i - 1, r.uid); }
        else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveRow(i, i + 1, r.uid); }
      });
      tr.addEventListener('dragover', function (e) {
        if (dragUid == null) return;
        e.preventDefault();
        var d = dropIndex(i, e, tr);
        tr.classList.toggle('drop-above', !d.below); tr.classList.toggle('drop-below', d.below);
      });
      tr.addEventListener('dragleave', function () { tr.classList.remove('drop-above', 'drop-below'); });
      tr.addEventListener('drop', function (e) {
        e.preventDefault();
        var d = dropIndex(i, e, tr), from = rows.findIndex(function (x) { return x.uid === dragUid; });
        clearDrop(); dragUid = null;
        if (from < 0) return;
        var to = d.to; if (from < to) to--;
        moveRow(from, to);
      });
      td('c', handle);
      td('n', document.createTextNode(String(i + 1)));

      var ttl = el('span', { 'class': 'ttl', text: r.title || r.id });
      var tag = el('span', { 'class': 'now-tag' });
      var tcell = td('', el('div', { 'class': 'tcell', title: (r.title || r.id) + '  (' + r.id + ')' }, [ttl, tag]));

      var repSt = repeatsStepper(r.repeats, function (v) { r.repeats = v; persist(); revalidate(r, tr); refreshHighlight(); });
      var spSt = speedStepper(r.speed, function (v) { r.speed = v; persist(); revalidate(r, tr); });
      td('c', repSt.el); td('c', spSt.el);

      var stIn = textInput(r.start, '0:00', function (inp) { r.start = inp.value.trim(); persist(); revalidate(r, tr); });
      var enIn = textInput(r.end, 'end', function (inp) { r.end = inp.value.trim(); persist(); revalidate(r, tr); });
      stIn.setAttribute('aria-label', 'Start time'); enIn.setAttribute('aria-label', 'End time');
      td('rg', stIn); td('rg', enIn);

      td('act', [
        mini('▶', 'Start the list from this video', function () { if (!r.on) { r.on = true; cb.checked = true; tr.classList.remove('off'); persist(); } playFrom(r.uid); }, 'go'),
        mini('⧉', 'Duplicate below', function () { var c = makeRow(r); c.title = r.title; rows.splice(i + 1, 0, c); persist(); renderRows(); }),
        mini('✕', 'Remove', function () { rows.splice(i, 1); persist(); renderRows(); })
      ]);
      tb.appendChild(tr);
      revalidate(r, tr);
    });
    $('#emptyMsg').classList.toggle('hidden', rows.length > 0);
    syncAllCb(); paintRange();
    persist();
    refreshHighlight();
  }
  function syncAllCb() {
    var c = $('#selAllCb'), n = rows.filter(function (r) { return r.on; }).length;
    c.checked = rows.length > 0 && n === rows.length; c.indeterminate = n > 0 && n < rows.length;
  }
  $('#selAllCb').addEventListener('change', function () { var v = this.checked; rows.forEach(function (r) { r.on = v; }); renderRows(); });

  function refreshHighlight() {
    document.querySelectorAll('#rows tr.row').forEach(function (tr) {
      var uid = Number(tr.getAttribute('data-uid'));
      var isCur = started && uid === cur.uid;
      tr.classList.toggle('current', isCur);
      var tg = tr.querySelector('.now-tag');
      var r = rows.find(function (x) { return x.uid === uid; });
      tg.textContent = isCur && r ? cur.rep + '/' + r.repeats : '';
    });
  }

  // ---------- adding videos ----------
  var defRep = repeatsStepper(1, onSettings, true), defSp = speedStepper(1, onSettings, true);
  $('#defRepeatsMount').appendChild(defRep.el);
  $('#defSpeedMount').appendChild(defSp.el);
  function addRows(list, replace, defRep, defSp) {
    var made = list.map(function (o) { return makeRow({ id: o.id, title: o.title, repeats: o.repeats || defRep, speed: o.speed || defSp, start: o.start, end: o.end, on: o.on }); });
    rows = replace ? made : rows.concat(made);
    renderRows();
    fetchTitles(made.map(function (r) { return r.id; }));
  }
  function defaults() {
    return { rep: defRep.get(), sp: defSp.get() };
  }

  $('#oneAdd').addEventListener('click', function () {
    try {
      var id = extractId($('#oneLink').value), d = defaults();
      addRows([{ id: id }], false, d.rep, d.sp);
      $('#oneLink').value = '';
      say($('#oneMsg'), 'Added.', 'good');
    } catch (e) { say($('#oneMsg'), e.message, 'bad'); }
  });

  // Reads a public YouTube page (playlist or channel) and follows YouTube's "load more" requests.
  // This runs from the extension page, which is allowed to read youtube.com (see host_permissions).
  var YT_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', YT_VER = '2.20250101.00.00';
  function ytApi(path, body, key, ver) {
    body.context = { client: { clientName: 'WEB', clientVersion: ver || YT_VER, hl: 'en', gl: 'US' } };
    return fetch('https://www.youtube.com/youtubei/v1/' + path + '?prettyPrint=false&key=' + encodeURIComponent(key || YT_KEY), {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': ver || YT_VER }, body: JSON.stringify(body)
    }).then(function (r) { if (!r.ok) throw new Error('YouTube answered with status ' + r.status + '.'); return r.json(); });
  }
  // Fallback when the web page is not the usual desktop page (for example the mobile page on iPhone):
  // ask YouTube's own data endpoint for the same list.
  async function fetchViaApi(api) {
    var browseId = api.browseId, params = api.params;
    if (!browseId && api.resolveUrl) {
      var rj = await ytApi('navigation/resolve_url', { url: api.resolveUrl });
      var be = rj && rj.endpoint && rj.endpoint.browseEndpoint;
      if (!be || !be.browseId) throw new Error('YouTube could not find that channel.');
      browseId = be.browseId; params = api.params;
    }
    var body = { browseId: browseId }; if (params) body.params = params;
    return ytApi('browse', body);
  }
  async function fetchCollection(url, collect, progress, maxItems, api) {
    var html = '', data = null, key = YT_KEY, ver = YT_VER, why = '';
    function look(h) {
      var names = ['ytInitialData', 'JSON.parse(', 'playlistVideoRenderer', 'videoWithContextRenderer', 'compactVideoRenderer', 'lockupViewModel', 'consent.youtube', 'gridPlaylistRenderer'];
      return names.filter(function (n) { return h.indexOf(n) >= 0; }).join('+') || 'none of the usual markers';
    }
    try {
      var res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) why = 'status ' + res.status;
      else {
        html = await res.text();
        data = extractJsonAssigned(html, 'ytInitialData');
        var host = res.url ? res.url.replace(/^https?:\/\/([^\/]+).*/, '$1') : '';
        if (!data && /^m\./.test(host)) {
          // the mobile page: ask for the desktop page instead
          try {
            var res2 = await fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'app=desktop', { credentials: 'omit' });
            if (res2.ok) { var h2 = await res2.text(); var d2 = extractJsonAssigned(h2, 'ytInitialData'); if (d2) { html = h2; data = d2; } }
          } catch (e1) {}
        }
        if (!data) why = 'unexpected page' + (host ? ' from ' + host : '') + ', ' + html.length + ' bytes, has: ' + look(html);
        key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || YT_KEY;
        ver = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || YT_VER;
      }
    } catch (e) { why = 'blocked (' + (e && e.message || e) + ')'; }
    if (!data && api) {
      try { data = await fetchViaApi(api); }
      catch (e2) {
        if (/blocked/.test(why)) throw new Error('The browser blocked access to youtube.com. In Safari, open Settings > Extensions > Repeat Playlist Player and allow youtube.com (or all websites).');
        throw new Error('Could not read that YouTube page (' + why + '; ' + (e2 && e2.message || 'data endpoint failed') + '). It may be private, or YouTube changed its layout.');
      }
    }
    if (!data) throw new Error('Could not read that YouTube page (' + why + '). It may be private, or YouTube changed its layout.');
    var c = collect(data), out = c.items.slice(), token = c.token, guard = 0;
    if (progress) progress(out.length);
    while (token && out.length < maxItems && guard++ < 80) {
      var j;
      try { j = await ytApi('browse', { continuation: token }, key, ver); } catch (e3) { break; }
      c = collect(j);
      out = out.concat(c.items); token = c.token;
      if (progress) progress(out.length);
    }
    return { items: out, data: data };
  }
  function fetchPlaylistVideos(listId, progress) {
    if (window.RPP_INAPP && window.RPP_INAPP.importPlaylist) {   // web app: browsers cannot read youtube.com pages, so use YouTube's player API
      return window.RPP_INAPP.importPlaylist(listId).then(function (ids) { return { videos: ids.map(function (id) { return { id: id, title: '' }; }), title: '' }; });
    }
    return fetchCollection('https://www.youtube.com/playlist?list=' + encodeURIComponent(listId) + '&hl=en', collectPlaylist, progress, 5000, { browseId: 'VL' + listId })
      .then(function (r) { return { videos: r.items, title: playlistTitle(r.data) }; });
  }
  function playlistUrl(id) { return 'https://www.youtube.com/playlist?list=' + id; }
  function doImport(asNew) {
    var msg = $('#plMsg'), listId;
    try { listId = extractListId($('#plLink').value); } catch (e) { say(msg, e.message, 'bad'); return; }
    say(msg, 'Loading playlist...');
    $('#plReplace').disabled = $('#plAppend').disabled = true;
    fetchPlaylistVideos(listId, function (n) { say(msg, 'Loaded ' + n + ' videos so far...'); }).then(function (r) {
      var vids = r.videos;
      if (!vids.length) throw new Error('No videos found. The playlist may be private or empty.');
      vids.forEach(function (v) { if (v.title) titles[v.id] = v.title; });
      titlesDirty = true;
      var d = defaults();
      if (asNew) { var L = createList({ name: r.title || 'Playlist', source: playlistUrl(listId), defRepeats: d.rep, defSpeed: d.sp }); switchTo(L.id); }
      else { var A = activeList(); if (A && !A.source) { A.source = playlistUrl(listId); renderListUI(); } }
      addRows(vids, false, d.rep, d.sp);
      showTab('lists');
      say(msg, 'Loaded ' + vids.length + ' videos' + (asNew ? ' into a new saved list.' : ' and added them to this list.'), 'good');
    }).catch(function (e) { say(msg, e.message || String(e), 'bad'); })
      .then(function () { $('#plReplace').disabled = $('#plAppend').disabled = false; });
  }
  $('#plReplace').addEventListener('click', function () { doImport(true); });
  $('#plAppend').addEventListener('click', function () { doImport(false); });

  // Titles come from YouTube's oEmbed endpoint when the browser allows it; otherwise they fill in as videos play.
  function fetchTitles(ids) {
    var todo = ids.filter(function (id, i) { return !titles[id] && ids.indexOf(id) === i; });
    var running = 0, MAX = 4;
    function next() {
      if (titleFetchBroken) return;
      while (running < MAX && todo.length) {
        (function (id) {
          running++;
          fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id))
            .then(function (r) { if (!r.ok) throw new Error('no'); return r.json(); })
            .then(function (j) { if (j && j.title) setTitle(id, j.title); })
            .catch(function (e) { if (e instanceof TypeError) titleFetchBroken = true; })
            .then(function () { running--; next(); });
        })(todo.shift());
      }
    }
    next();
  }
  window.RPP_ED = { setTitle: function (id, t) { setTitle(id, t); } };
  function setTitle(id, title) {
    titles[id] = title; titlesDirty = true; scheduleSave();
    var changed = false;
    rows.forEach(function (r) { if (r.id === id && !r.title) { r.title = title; changed = true; } });
    if (changed) {
      document.querySelectorAll('#rows tr.row').forEach(function (tr) {
        var r = rows.find(function (x) { return x.uid === Number(tr.getAttribute('data-uid')); });
        if (r && r.id === id) { tr.querySelector('.ttl').textContent = r.title; tr.querySelector('.tcell').title = r.title + '  (' + r.id + ')'; }
      });
    }
    persist();
  }

  // ---------- bulk tools ----------
  $('#reverse').addEventListener('click', function () { rows.reverse(); renderRows(); });
  $('#shuffle').addEventListener('click', function () {
    for (var i = rows.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = rows[i]; rows[i] = rows[j]; rows[j] = t; }
    renderRows();
  });
  var bulkRep = repeatsStepper(1, null, true), bulkSp = speedStepper(1, null, true);
  $('#bulkRepeatsMount').appendChild(bulkRep.el);
  $('#bulkSpeedMount').appendChild(bulkSp.el);
  $('#bulkRepeatsGo').addEventListener('click', function () {
    var v = bulkRep.get();
    rows.forEach(function (r) { if (r.on) r.repeats = v; }); renderRows();
  });
  $('#bulkSpeedGo').addEventListener('click', function () {
    var v = bulkSp.get();
    rows.forEach(function (r) { if (r.on) r.speed = v; }); renderRows();
  });

  // ---------- hand-off to youtube.com (the content script there plays the plan) ----------
  function planFrom(startUid) {
    var q = queue(), from = 0;
    if (startUid != null) { var k = q.findIndex(function (r) { return r.uid === startUid; }); if (k >= 0) from = k; }
    q = q.slice(from);
    var lines = q.map(function (r) { return serializeRow({ id: r.id, on: true, title: '', repeats: r.repeats, speed: r.speed, start: r.start, end: r.end }); });
    if ($('#loop').checked) lines.unshift('#loop');
    return { text: lines.join('\n'), first: q.length ? q[0].id : null };
  }
  function b64url(text) { return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function openPlan(startUid) {
    var pl = planFrom(startUid);
    if (!pl.first) { say($('#ytMsg'), 'Select at least one valid video first.', 'bad'); return; }
    if (window.RPP_INAPP && window.RPP_INAPP.play) {   // the Android/web app plays inside the app
      var qq = queue(), kk = 0;
      if (startUid != null) { var jj = qq.findIndex(function (r) { return r.uid === startUid; }); if (jj >= 0) kk = jj; }
      window.RPP_INAPP.play(qq.slice(kk).map(function (r) { return { id: r.id, title: r.title, repeats: Number(r.repeats), speed: Number(r.speed), start: r.start, end: r.end }; }), $('#loop').checked);
      return;
    }
    window.open('https://www.youtube.com/watch?v=' + pl.first + '#rpp=' + b64url(pl.text), '_blank');
    say($('#ytMsg'), 'Opened youtube.com. The plan starts there.', 'good');
  }
  function playFrom(uid) { openPlan(uid); }
  $('#ytOpen').addEventListener('click', function () { openPlan(null); });
  $('#ytCopy').addEventListener('click', function () {
    var pl = planFrom(null);
    if (!pl.first) { say($('#ytMsg'), 'Select at least one valid video first.', 'bad'); return; }
    function fallback() {
      var t = document.createElement('textarea'); t.value = pl.text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(t);
      say($('#ytMsg'), ok ? 'Plan copied.' : 'Could not copy. Use the Text view instead.', ok ? 'good' : 'bad');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pl.text).then(function () { say($('#ytMsg'), 'Plan copied.', 'good'); }, fallback);
    else fallback();
  });

  // ---------- saved lists: switching, naming, deleting ----------
  function newId() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function uniqueName(base) {
    var names = store.lists.map(function (l) { return l.name; }), n = String(base).slice(0, 70), i = 2;
    while (names.indexOf(n) >= 0) n = String(base).slice(0, 70) + ' (' + (i++) + ')';
    return n;
  }
  function createList(o) {
    var now = Date.now();
    var L = normList({ id: newId(), name: uniqueName(o.name || 'New list'), source: o.source || '', created: now, updated: now,
      loop: !!o.loop, defRepeats: o.defRepeats || 1, defSpeed: o.defSpeed || 1, data: o.data || '' });
    store.lists.push(L);
    scheduleSave();
    return L;
  }
  function onSettings() {
    var L = activeList();
    if (!L) return;
    L.loop = $('#loop').checked; L.defRepeats = defRep.get(); L.defSpeed = defSp.get(); L.updated = Date.now();
    scheduleSave();
  }
  function applySettings() {
    var L = activeList();
    if (!L) return;
    $('#loop').checked = !!L.loop; defRep.set(L.defRepeats); defSp.set(L.defSpeed);
  }
  function switchTo(id) {
    activeId = id;
    var L = activeList();
    rows = decodeRows(L.data).map(makeRow);
    applySettings(); renderRows(); renderListUI();
    localSet(LOCAL_ACTIVE, activeId);
    fetchTitles(rows.map(function (r) { return r.id; }));
  }
  function renderListUI() {
    var sel = $('#listSelect');
    sel.innerHTML = '';
    store.lists.forEach(function (l) {
      var o = document.createElement('option'); o.value = l.id; o.textContent = l.name; sel.appendChild(o);
    });
    sel.value = activeId;
    var L = activeList();
    $('#listName').value = L ? L.name : '';
    $('#listSource').value = L ? L.source : '';
    var dl = $('#chanList');
    dl.innerHTML = '';
    store.channels.forEach(function (c) { var o = document.createElement('option'); o.value = c.url; o.label = c.name; dl.appendChild(o); });
    resetDelete(); renderSyncStatus();
  }
  $('#listSelect').addEventListener('change', function () { switchTo(this.value); });
  $('#listName').addEventListener('input', function () {
    var L = activeList(); if (!L) return;
    L.name = this.value.trim().slice(0, 80) || 'Untitled'; L.updated = Date.now();
    var opt = $('#listSelect').selectedOptions[0]; if (opt) opt.textContent = L.name;
    scheduleSave();
  });
  $('#listSource').addEventListener('input', function () {
    var L = activeList(); if (!L) return;
    L.source = this.value.trim().slice(0, 200); L.updated = Date.now(); scheduleSave();
  });
  $('#loop').addEventListener('change', onSettings);
  $('#listNew').addEventListener('click', function () { var L = createList({ name: 'New list' }); switchTo(L.id); });
  $('#listDup').addEventListener('click', function () {
    var A = activeList(); if (!A) return;
    var L = createList({ name: A.name + ' copy', source: A.source, loop: A.loop, defRepeats: A.defRepeats, defSpeed: A.defSpeed, data: A.data });
    switchTo(L.id);
  });
  var delArmed = false, delTimer = null;
  function resetDelete() { delArmed = false; clearTimeout(delTimer); $('#listDel').textContent = 'Delete'; }
  $('#listDel').addEventListener('click', function () {
    if (!delArmed) {
      delArmed = true; this.textContent = 'Click again to delete';
      delTimer = setTimeout(resetDelete, 3000); return;
    }
    resetDelete();
    var id = activeId;
    store.lists = store.lists.filter(function (l) { return l.id !== id; });
    store.deleted[id] = Date.now();
    if (!store.lists.length) createList({ name: 'New list' });
    switchTo(store.lists[0].id);
    scheduleSave();
  });

  // ---------- picking playlists from a channel ----------
  var chanRep = repeatsStepper(1, null, true), chanSp = speedStepper(1, null, true), chanItems = [];
  $('#chanRepMount').appendChild(chanRep.el);
  $('#chanSpMount').appendChild(chanSp.el);
  function savedPlaylistIds() {
    var s = {};
    store.lists.forEach(function (l) { try { s[extractListId(l.source)] = true; } catch (e) {} });
    return s;
  }
  function renderChannelRows() {
    var tb = $('#chanRows'); tb.innerHTML = '';
    chanItems.forEach(function (it) {
      var tr = el('tr', { 'class': 'row' + (it.sel ? '' : ' off') });
      function td(cls, kid) { var c = el('td', { 'class': cls || '' }); c.appendChild(kid); tr.appendChild(c); return c; }
      var cb = el('input', { type: 'checkbox', 'aria-label': 'Keep ' + it.title });
      cb.checked = it.sel;
      cb.addEventListener('change', function () { it.sel = cb.checked; tr.classList.toggle('off', !it.sel); syncChanAll(); });
      td('c', cb);
      var label = it.title + (it.saved ? '  (already saved)' : '');
      td('', el('div', { 'class': 'tcell', title: label + '  (' + it.id + ')' }, [el('span', { 'class': 'ttl', text: it.title }), el('span', { 'class': 'now-tag', text: it.saved ? 'saved' : '' })]));
      td('ct', document.createTextNode(String(it.count || '').replace(/\s*videos?/i, '')));
      td('c', repeatsStepper(it.repeats, function (v) { it.repeats = v; }).el);
      td('c', speedStepper(it.speed, function (v) { it.speed = v; }).el);
      tb.appendChild(tr);
    });
    syncChanAll();
    $('#chanResults').classList.toggle('hidden', !chanItems.length);
  }
  function syncChanAll() {
    var c = $('#chanAllCb'), n = chanItems.filter(function (i) { return i.sel; }).length;
    c.checked = chanItems.length > 0 && n === chanItems.length; c.indeterminate = n > 0 && n < chanItems.length;
  }
  $('#chanAllCb').addEventListener('change', function () { var v = this.checked; chanItems.forEach(function (i) { i.sel = v; }); renderChannelRows(); });
  $('#chanApply').addEventListener('click', function () {
    chanItems.forEach(function (i) { if (i.sel) { i.repeats = chanRep.get(); i.speed = chanSp.get(); } }); renderChannelRows();
  });
  $('#chanFind').addEventListener('click', function () {
    var msg = $('#chanMsg'), url, input = $('#chanInput').value.trim();
    try { url = channelPlaylistsUrl(input); } catch (e) { say(msg, e.message, 'bad'); return; }
    say(msg, 'Looking for playlists...');
    $('#chanFind').disabled = true;
    var found = (window.RPP_INAPP && window.RPP_INAPP.channelPlaylists) ? window.RPP_INAPP.channelPlaylists(input).then(function (x) { return { items: x.items, data: null, apiTitle: x.title }; }) :
      fetchCollection(url, collectChannelPlaylists, function (n) { say(msg, 'Found ' + n + ' playlists so far...'); }, 500, { resolveUrl: url.replace(/\/playlists$/, ''), params: 'EglwbGF5bGlzdHM=' });
    found.then(function (r) {
      if (!r.items.length) throw new Error('No public playlists found on that channel.');
      var name = r.apiTitle || channelTitle(r.data) || input;
      if (!store.channels.some(function (c) { return c.url === input; })) { store.channels.unshift({ url: input.slice(0, 120), name: name.slice(0, 60) }); store.channels = store.channels.slice(0, 10); scheduleSave(); renderListUI(); }
      var saved = savedPlaylistIds();
      chanItems = r.items.map(function (it) { return { id: it.id, title: it.title, count: it.count, sel: false, repeats: chanRep.get(), speed: chanSp.get(), saved: !!saved[it.id] }; });
      renderChannelRows();
      say(msg, 'Found ' + chanItems.length + ' playlists on ' + name + '. Tick the ones to keep.', 'good');
    }).catch(function (e) { chanItems = []; renderChannelRows(); say(msg, e.message || String(e), 'bad'); })
      .then(function () { $('#chanFind').disabled = false; });
  });
  $('#chanSave').addEventListener('click', async function () {
    var msg = $('#chanMsg'), picked = chanItems.filter(function (i) { return i.sel; });
    if (!picked.length) { say(msg, 'Tick at least one playlist first.', 'bad'); return; }
    $('#chanSave').disabled = true;
    var firstId = null, done = 0, failed = [];
    for (var n = 0; n < picked.length; n++) {
      var it = picked[n];
      say(msg, 'Saving ' + (n + 1) + ' of ' + picked.length + ': ' + it.title + '...');
      try {
        var r = await fetchPlaylistVideos(it.id);
        if (!r.videos.length) throw new Error('no videos found');
        r.videos.forEach(function (v) { if (v.title) titles[v.id] = v.title; });
        titlesDirty = true;
        var data = encodeRows(r.videos.map(function (v) { return { id: v.id, on: true, repeats: it.repeats, speed: it.speed, start: '', end: '' }; }));
        var L = createList({ name: it.title || r.title, source: playlistUrl(it.id), defRepeats: it.repeats, defSpeed: it.speed, data: data });
        if (!firstId) firstId = L.id;
        it.saved = true; it.sel = false; done++;
      } catch (err) { failed.push(it.title + ' (' + (err.message || err) + ')'); }
      if (n + 1 < picked.length) await sleep(300);
    }
    if (firstId) { switchTo(firstId); showTab('lists'); }
    renderChannelRows();
    say(msg, 'Saved ' + done + ' list' + (done === 1 ? '' : 's') + ' with their settings.' + (failed.length ? ' Could not load: ' + failed.join('; ') : ''), failed.length ? 'bad' : 'good');
    $('#chanSave').disabled = false;
  });

  // ---------- backup and restore ----------
  function backupText() { return JSON.stringify({ v: 1, lists: store.lists, channels: store.channels }, null, 1); }
  $('#bkCopy').addEventListener('click', function () {
    var text = backupText(), msg = $('#bkMsg');
    function fallback() {
      var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(t); say(msg, ok ? 'Backup copied.' : 'Could not copy. Use Download instead.', ok ? 'good' : 'bad');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { say(msg, 'Backup copied.', 'good'); }, fallback); else fallback();
  });
  $('#bkDownload').addEventListener('click', function () {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([backupText()], { type: 'application/json' }));
    a.download = 'repeat-playlist-backup.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    say($('#bkMsg'), 'Backup downloaded.', 'good');
  });
  function restoreFrom(text) {
    var msg = $('#bkMsg');
    try {
      var incoming = sanitizeStore(JSON.parse(text)), before = store.lists.length;
      store = mergeStores(store, incoming);
      ensureActive(); switchTo(activeId); scheduleSave();
      say(msg, 'Restored. You now have ' + store.lists.length + ' lists (' + (store.lists.length - before) + ' new).', 'good');
    } catch (e) { say(msg, e.message || 'Could not read that backup.', 'bad'); }
  }
  $('#bkRestore').addEventListener('click', function () { restoreFrom($('#bkText').value); });
  $('#bkFile').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    var rd = new FileReader(); rd.onload = function () { restoreFrom(String(rd.result)); }; rd.readAsText(f);
  });

  // ---------- keeping devices in step ----------
  function ensureActive() {
    if (!store.lists.length) createList({ name: 'New list' });
    if (!store.lists.some(function (l) { return l.id === activeId; })) activeId = store.lists[0].id;
  }
  function isEditing() {
    var a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && a.type !== 'checkbox');
  }
  var pullTimer = null;
  function onRemoteChange() {
    if (isEditing()) { pullTimer = setTimeout(onRemoteChange, 1500); return; }
    readRemote().then(function (remote) {
      if (!applyRemote(remote)) return;
      say($('#syncMsg'), 'Updated from another device.', 'good');
      scheduleSave();
    }).catch(function () {});
  }
  setInterval(function () { if (nativeMode && !document.hidden && !flushing) { clearTimeout(pullTimer); onRemoteChange(); } }, 8000);
  if (hasSync && api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener(function (ch, area) { if (area === 'sync') { clearTimeout(pullTimer); pullTimer = setTimeout(onRemoteChange, 400); } });
  }


  // ---------- tabs ----------
  var TABS = ['lists', 'new', 'more'];
  function showTab(name) {
    TABS.forEach(function (t) {
      $('#tab-' + t).setAttribute('aria-selected', String(t === name));
      $('#pane-' + t).classList.toggle('hidden', t !== name);
    });
  }
  TABS.forEach(function (t) {
    $('#tab-' + t).addEventListener('click', function () { showTab(this.getAttribute('aria-selected') === 'true' ? null : t); });
  });
  function showMode(m) {
    $('#sec-list').classList.toggle('hidden', m !== 'list'); $('#sec-chan').classList.toggle('hidden', m !== 'chan');
    $('#modeList').setAttribute('aria-pressed', String(m === 'list')); $('#modeChan').setAttribute('aria-pressed', String(m === 'chan'));
  }
  $('#modeList').addEventListener('click', function () { showMode('list'); });
  $('#modeChan').addEventListener('click', function () { showMode('chan'); });

  // ---------- startup ----------
  (function init() {
    setupNative().then(function () { return Promise.all([
      localGet(LOCAL_STORE), localGet(LOCAL_ACTIVE), localGet(LOCAL_TITLES),
      hasSync ? readRemote().catch(function () { syncState = 'error'; return null; }) : null
    ]); }).then(function (r) {
      if (r[2]) titles = r[2];
      var local = (r[0] && Array.isArray(r[0].lists)) ? r[0] : emptyStore();
      store = mergeStores(local, r[3]);
      if (!store.lists.length) {
        // first run: bring over the single list kept by earlier versions, otherwise start with an example
        var legacy = null;
        try { legacy = JSON.parse(loadLocal(LEGACY_ROWS) || 'null'); } catch (e) { legacy = null; }
        try { var lt = JSON.parse(loadLocal(LEGACY_TITLES) || 'null'); if (lt) Object.keys(lt).forEach(function (k) { if (!titles[k]) titles[k] = lt[k]; }); } catch (e) {}
        var items = Array.isArray(legacy) && legacy.length ? legacy.filter(function (x) { return x && /^[A-Za-z0-9_-]{11}$/.test(x.id); }) : parsePlan(DEFAULT_PLAN).items;
        createList({ name: Array.isArray(legacy) && legacy.length ? 'My list' : 'Example list', data: encodeRows(items) });
      }
      activeId = (r[1] && store.lists.some(function (l) { return l.id === r[1]; })) ? r[1] : store.lists[0].id;
      switchTo(activeId);
      if (hasSync && syncState === 'checking') syncState = 'synced';
      scheduleSave();
    });
  })();
})();
