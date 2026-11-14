// In-app player for the web/Android app: plays the list inside the app using YouTube's embedded player.
// Embedded players are limited to 2x. This file is only loaded by the app (index.html), not the browser extensions.
(function () {
  'use strict';
  var player = null, apiReady = false, apiLoading = false, importer = null, importReady = false, importWait = null;
  var waiters = [];
  var items = [], idx = 0, rep = 1, loop = false, started = false, watchdog = null, wakeLock = null, ticking = null;
  function $(s) { return document.querySelector(s); }
  function el(tag, attrs, text) { var e = document.createElement(tag); if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); if (text) e.textContent = text; return e; }

  // ---------- overlay ----------
  var ov = el('div', { id: 'rppOv', 'aria-hidden': 'true' });
  var css = el('style');
  css.textContent = '#rppOv{position:fixed;inset:0;background:#000;z-index:1000;display:none;flex-direction:column;color:#e8eaed;font:14px/1.4 system-ui,sans-serif}' +
    '#rppOv.on{display:flex}#rppBox{position:relative;width:100%;aspect-ratio:16/9;background:#000;flex:none;max-height:60vh}#rppBox>div,#rppBox iframe{position:absolute;inset:0;width:100%;height:100%}' +
    '#rppInfo{padding:12px 14px;flex:1;overflow:auto}#rppTitle{font-size:17px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#rppMeta{color:#ff9a4d;margin-top:2px;font-variant-numeric:tabular-nums}#rppNote{color:#9aa3ad;margin-top:6px;font-size:12.5px}#rppMsg{margin-top:6px;color:#ff6b6b;font-size:13px;min-height:1em}' +
    '#rppBar{display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid #2a2f35;background:#101214}' +
    '#rppBar button{flex:1;font:inherit;font-weight:600;color:#e8eaed;background:#232830;border:1px solid #2a2f35;border-radius:10px;padding:14px 4px}#rppBar button.p{background:#ff7a1a;border-color:#ff7a1a;color:#1a0e02}' +
    '#rppTap{display:none;position:absolute;inset:0;background:rgba(0,0,0,.55);z-index:2;align-items:center;justify-content:center}#rppTap.on{display:flex}#rppTap button{font:inherit;font-size:18px;font-weight:700;padding:14px 26px;border-radius:12px;border:0;background:#ff7a1a;color:#1a0e02}';
  document.head.appendChild(css);
  var box = el('div', { id: 'rppBox' }); box.appendChild(el('div', { id: 'rppPlayer' }));
  var tap = el('div', { id: 'rppTap' }); var tapBtn = el('button', null, 'Tap to play'); tap.appendChild(tapBtn); box.appendChild(tap);
  var info = el('div', { id: 'rppInfo' });
  var title = el('div', { id: 'rppTitle' }), meta = el('div', { id: 'rppMeta' }), note = el('div', { id: 'rppNote' }), msg = el('div', { id: 'rppMsg' });
  [title, meta, note, msg].forEach(function (x) { info.appendChild(x); });
  var bar = el('div', { id: 'rppBar' });
  var bPrev = el('button', null, '⏮ Prev'), bPause = el('button', { 'class': 'p' }, 'Pause'), bNext = el('button', null, 'Next ⏭'), bClose = el('button', null, 'Close');
  [bPrev, bPause, bNext, bClose].forEach(function (x) { bar.appendChild(x); });
  ov.appendChild(box); ov.appendChild(info); ov.appendChild(bar);
  document.body.appendChild(ov);
  var hidden = el('div', { style: 'position:absolute;left:-9999px;top:0;width:200px;height:200px' }); hidden.appendChild(el('div', { id: 'rppImporter' }));
  document.body.appendChild(hidden);

  // ---------- YouTube API ----------
  function loadApi() {
    return new Promise(function (resolve) {
      if (apiReady) { resolve(); return; }
      waiters.push(resolve);
      if (apiLoading) return;
      apiLoading = true;
      window.onYouTubeIframeAPIReady = function () {
        apiReady = true;
        var origin = /^https?:/.test(location.protocol) ? { origin: location.origin } : {};
        player = new YT.Player('rppPlayer', { width: '100%', height: '100%', playerVars: Object.assign({ playsinline: 1, rel: 0, modestbranding: 1 }, origin),
          events: { onStateChange: onState, onError: onError, onAutoplayBlocked: function () { tap.classList.add('on'); } } });
        importer = new YT.Player('rppImporter', { width: 200, height: 200, playerVars: Object.assign({ playsinline: 1 }, origin),
          events: { onReady: function () { importReady = true; }, onStateChange: function (e) { if (e.data === 5 && importWait) importWait.ok(); }, onError: function (e) { if (importWait) importWait.fail(e.data); } } });
        waiters.splice(0).forEach(function (f) { f(); });
      };
      var t = document.createElement('script'); t.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(t);
    });
  }

  function importPlaylist(listId) {
    return loadApi().then(function () {
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function waitReady() {
          if (importReady) return go();
          if (++tries > 40) return reject(new Error('The YouTube player did not load. Check your connection and try again.'));
          setTimeout(waitReady, 250);
        })();
        function go() {
          var done = false, timer = setTimeout(function () { fin(new Error('Timed out. Check that the playlist is public and the link is right.')); }, 15000);
          function fin(r) { if (done) return; done = true; clearTimeout(timer); importWait = null; if (r instanceof Error) reject(r); else resolve(r); }
          importWait = {
            ok: function () { setTimeout(function () { var ids = importer.getPlaylist(); if (ids && ids.length) fin(ids.slice()); else fin(new Error('The playlist loaded but returned no videos. It may be private or empty.')); }, 300); },
            fail: function (c) { fin(new Error('YouTube could not load that playlist (error ' + c + '). It must be public or unlisted.')); }
          };
          importer.cuePlaylist({ listType: 'playlist', list: listId });
        }
      });
    });
  }

  // ---------- playback ----------
  function cur() { return items[idx]; }
  function begin() {
    var r = cur(); if (!r) { finish(); return; }
    started = true; tap.classList.remove('on'); msg.textContent = '';
    var o = { videoId: r.id, startSeconds: parseTime(r.start) || 0 }, e = parseTime(r.end); if (e != null) o.endSeconds = e;
    player.loadVideoById(o);
    paint();
    clearTimeout(watchdog);
    watchdog = setTimeout(function () { var s = player.getPlayerState(); if (s !== 1 && s !== 3) tap.classList.add('on'); }, 3500);
  }
  function advance(kind) {
    var pos = kind === 'prev' ? prevPos(items, idx, rep) : nextPos(items, idx, rep, loop);
    if (!pos) { finish(); return; }
    idx = pos.idx; rep = pos.rep; begin();
  }
  function finish() { started = false; title.textContent = 'Finished'; meta.textContent = ''; note.textContent = 'Reached the end of the list.'; bPause.textContent = 'Close'; }
  function paint() {
    var r = cur(); if (!r) return;
    title.textContent = r.title || r.id;
    meta.textContent = 'Video ' + (idx + 1) + ' of ' + items.length + '  ·  play ' + rep + ' of ' + r.repeats + '  ·  ' + r.speed + '×';
    bPause.textContent = 'Pause';
  }
  function enforceRate() {
    var r = cur(); if (!player || !started || !r || !player.getAvailablePlaybackRates) return;
    var rates = player.getAvailablePlaybackRates(); if (!rates || !rates.length) rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    var want = Number(r.speed), target = nearestRate(want, rates);
    if (player.getPlaybackRate() !== target) player.setPlaybackRate(target);
    note.textContent = target !== want ? 'YouTube limits embedded players to ' + target + '×, so this video plays at ' + target + '× instead of ' + want + '×.' : '';
  }
  function onState(e) {
    if (e.data === 1) {
      clearTimeout(watchdog); tap.classList.remove('on'); enforceRate(); bPause.textContent = 'Pause';
      var d = player.getVideoData && player.getVideoData(), r = cur();
      if (d && d.title && r) { if (!r.title) { r.title = d.title; paint(); } if (window.RPP_ED) window.RPP_ED.setTitle(r.id, d.title); }
    } else if (e.data === 2) bPause.textContent = 'Resume';
    else if (e.data === 0 && started) advance('next');
  }
  function onError(e) {
    var c = e.data, r = cur(), m;
    if (c === 101 || c === 150) m = 'The owner of this video does not allow embedding. Skipping it.';
    else if (c === 100) m = 'This video is unavailable. Skipping it.';
    else if (c === 153 || c === 152) m = 'YouTube refused to play inside the app (error ' + c + ').';
    else m = 'Playback error ' + c + '. Skipping.';
    msg.textContent = m;
    if (c !== 153 && c !== 152 && started) { if (r) rep = r.repeats; setTimeout(function () { advance('next'); }, 1500); }
  }
  setInterval(function () { if (started && player && player.getPlayerState && player.getPlayerState() === 1) enforceRate(); }, 1000);

  function wake(on) {
    try {
      if (on && navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
      else if (wakeLock) { wakeLock.release(); wakeLock = null; }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && started) wake(true); });

  function play(list, lp) {
    items = list.map(function (x) { return Object.assign({}, x); }); loop = !!lp; idx = 0; rep = 1;
    ov.classList.add('on'); ov.setAttribute('aria-hidden', 'false'); title.textContent = 'Loading player...'; meta.textContent = ''; note.textContent = ''; msg.textContent = '';
    loadApi().then(function () { var n = 0; (function w() { if (player && player.loadVideoById) { wake(true); begin(); } else if (n++ < 40) setTimeout(w, 250); else msg.textContent = 'The YouTube player did not load.'; })(); });
  }
  function close() { started = false; clearTimeout(watchdog); try { player && player.stopVideo(); } catch (e) {} wake(false); ov.classList.remove('on'); ov.setAttribute('aria-hidden', 'true'); }
  bPause.addEventListener('click', function () {
    if (!started && title.textContent === 'Finished') { close(); return; }
    var s = player.getPlayerState(); if (s === 1) player.pauseVideo(); else player.playVideo();
  });
  bNext.addEventListener('click', function () { if (started) advance('next'); });
  bPrev.addEventListener('click', function () { if (started) advance('prev'); });
  bClose.addEventListener('click', close);
  tapBtn.addEventListener('click', function () { tap.classList.remove('on'); if (started) { try { player.playVideo(); } catch (e) {} } });


  // ---- Channel browsing via YouTube Data API v3 (needs the user's own key) ----
  function getKey() { try { return (localStorage.getItem('rpp.ytkey') || window.RPP_YT_KEY || '').trim(); } catch (e) { return (window.RPP_YT_KEY || '').trim(); } }
  function yt(path, params) {
    var key = getKey();
    if (!key) return Promise.reject(new Error('Add a YouTube API key in the More tab first.'));
    params.key = key;
    var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch('https://www.googleapis.com/youtube/v3/' + path + '?' + q).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.error) {
          var m = (j.error && j.error.message) || ('HTTP ' + r.status);
          var reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
          if (reason === 'quotaExceeded') m = 'Daily YouTube API quota used up. Try again tomorrow.';
          throw new Error(m);
        }
        return j;
      });
    });
  }
  function resolveChannel(input) {
    input = String(input || '').trim();
    if (!input) return Promise.reject(new Error('Enter a channel link or @handle.'));
    var m, p = null, q = null;
    if ((m = input.match(/^(UC[\w-]{22})$/)) || (m = input.match(/youtube\.com\/channel\/(UC[\w-]{22})/i))) p = { id: m[1] };
    else if ((m = input.match(/^(@[\w.\-]+)$/)) || (m = input.match(/youtube\.com\/(@[\w.\-%]+)/i))) p = { forHandle: decodeURIComponent(m[1]) };
    else if ((m = input.match(/youtube\.com\/user\/([\w.\-%]+)/i))) p = { forUsername: decodeURIComponent(m[1]) };
    else if ((m = input.match(/youtube\.com\/c\/([\w.\-%]+)/i))) q = decodeURIComponent(m[1]);
    else return Promise.reject(new Error('That does not look like a YouTube channel link. Try the @handle or the channel address.'));
    var first = p ? yt('channels', Object.assign({ part: 'snippet', maxResults: 1 }, p)) :
      yt('search', { part: 'snippet', type: 'channel', q: q, maxResults: 1 }).then(function (s) {
        var it = s.items && s.items[0];
        return { items: it ? [{ id: it.snippet.channelId || (it.id && it.id.channelId), snippet: it.snippet }] : [] };
      });
    return first.then(function (j) {
      var c = j.items && j.items[0];
      if (!c || !c.id) throw new Error('Could not find that channel.');
      return { id: c.id, title: (c.snippet && c.snippet.title) || input };
    });
  }
  function channelPlaylists(input) {
    return resolveChannel(input).then(function (ch) {
      var items = [];
      function page(tok) {
        var pr = { part: 'snippet,contentDetails', channelId: ch.id, maxResults: 50 };
        if (tok) pr.pageToken = tok;
        return yt('playlists', pr).then(function (j) {
          (j.items || []).forEach(function (it) {
            var n = it.contentDetails && it.contentDetails.itemCount;
            items.push({ id: it.id, title: (it.snippet && it.snippet.title) || it.id, count: n != null ? n + ' videos' : '' });
          });
          if (j.nextPageToken && items.length < 500) return page(j.nextPageToken);
        });
      }
      return page(null).then(function () { return { title: ch.title, items: items }; });
    });
  }

  (function keyUi() {
    var inp = document.getElementById('ytKey'), msg = document.getElementById('ytKeyMsg'), mc = document.getElementById('modeChan');
    function refresh() {
      var has = !!getKey();
      if (mc) mc.style.display = has ? '' : 'none';
      if (inp && has && !inp.value) inp.placeholder = 'Key saved (hidden)';
    }
    var sv = document.getElementById('ytKeySave'), cl = document.getElementById('ytKeyClear');
    if (sv) sv.addEventListener('click', function () {
      var v = (inp.value || '').trim();
      if (!/^AIza[\w-]{30,}$/.test(v)) { msg.textContent = 'That does not look like a Google API key (starts with AIza).'; msg.className = 'msg bad'; return; }
      try { localStorage.setItem('rpp.ytkey', v); } catch (e) {}
      inp.value = ''; msg.textContent = 'Saved. "Browse a channel" is now available under Load new.'; msg.className = 'msg good'; refresh();
    });
    if (cl) cl.addEventListener('click', function () {
      try { localStorage.removeItem('rpp.ytkey'); } catch (e) {}
      inp.value = ''; inp.placeholder = 'API key'; msg.textContent = 'Key removed.'; msg.className = 'msg'; refresh();
    });
    refresh();
  })();
  window.RPP_INAPP = { play: play, importPlaylist: importPlaylist, channelPlaylists: channelPlaylists, hasKey: function () { return !!getKey(); } };
})();
