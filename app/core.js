// ---- pure logic (tested separately) ----
function extractId(s) {
  s = String(s || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  var m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  if (!m) throw new Error('no video ID found in "' + s + '"');
  return m[1];
}
function extractListId(s) {
  s = String(s || '').trim();
  var m = s.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^(PL|UU|OL|FL|LL)[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  throw new Error('no playlist ID found in "' + s + '"');
}
function parseTime(t) {
  if (t == null || String(t).trim() === '') return null;
  t = String(t).trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  var parts = t.split(':').map(Number);
  if (parts.length > 3 || parts.some(function (n) { return isNaN(n); })) throw new Error('bad time "' + t + '"');
  return parts.reduce(function (a, n) { return a * 60 + n; }, 0);
}
function validateRow(r) {
  var rep = Number(r.repeats), sp = Number(r.speed);
  if (!(Number.isInteger(rep) && rep >= 1 && rep <= 999)) return 'repeats must be a whole number from 1 to 999';
  if (!(sp >= 0.25 && sp <= 4)) return 'speed must be 0.25 to 4';
  var s, e;
  try { s = parseTime(r.start); e = parseTime(r.end); } catch (err) { return err.message; }
  if (s != null && e != null && e <= s) return 'end must be after start';
  return '';
}
function parsePlan(text) {
  var items = [], errors = [];
  text.split(/\r?\n/).forEach(function (raw, i) {
    var line = raw.trim(), on = true;
    if (line.indexOf('#off ') === 0) { on = false; line = line.slice(5).trim(); }
    else if (line.charAt(0) === '#') return;
    if (!line) return;
    var cm = line.split(/\s+#\s*/);
    var main = cm[0], title = cm.slice(1).join(' # ').trim();
    var p = main.split(',').map(function (x) { return x.trim(); });
    try {
      var row = {
        id: extractId(p[0]), title: title, on: on,
        repeats: p[1] ? Number(p[1]) : 1,
        speed: p[2] ? Number(p[2]) : 1,
        start: p[3] || '', end: p[4] || ''
      };
      var err = validateRow(row);
      if (err) throw new Error(err);
      items.push(row);
    } catch (e) {
      errors.push('Line ' + (i + 1) + ': ' + e.message);
    }
  });
  return { items: items, errors: errors };
}
function serializeRow(r) {
  var f = [r.id, r.repeats, r.speed, r.start || '', r.end || ''];
  while (f.length > 3 && f[f.length - 1] === '') f.pop();
  var t = String(r.title || '').replace(/[\r\n]+/g, ' ').trim();
  return (r.on ? '' : '#off ') + f.join(', ') + (t ? '  # ' + t : '');
}
function nextPos(items, idx, rep, loop) {
  if (rep < items[idx].repeats) return { idx: idx, rep: rep + 1 };
  if (idx + 1 < items.length) return { idx: idx + 1, rep: 1 };
  return loop ? { idx: 0, rep: 1 } : null;
}
function prevPos(items, idx, rep) {
  if (rep > 1) return { idx: idx, rep: Math.min(rep - 1, items[idx].repeats) };
  if (idx > 0) return { idx: idx - 1, rep: items[idx - 1].repeats };
  return { idx: 0, rep: 1 };
}
function nearestRate(want, rates) {
  return rates.reduce(function (best, r) { return Math.abs(r - want) < Math.abs(best - want) ? r : best; }, rates[0]);
}
function moveItem(arr, from, to) {
  if (to < 0 || to >= arr.length || from === to) return arr;
  var a = arr.slice(), x = a.splice(from, 1)[0];
  a.splice(to, 0, x);
  return a;
}
// ---- end pure logic ----

// ---- YouTube playlist page parsing ----
function textOf(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (t.simpleText) return t.simpleText;
  if (t.content) return t.content;
  if (t.runs) return t.runs.map(function (r) { return r.text; }).join('');
  return '';
}
// Walks YouTube's page data in document order and returns the playlist's videos plus the "load more" token, if any.
function collectPlaylist(root) {
  var main = [], lockups = [], mobile = [], token = null;
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i]); return; }
    if (o.playlistVideoRenderer) {
      var r = o.playlistVideoRenderer;
      if (r.videoId && r.isPlayable !== false) main.push({ id: r.videoId, title: textOf(r.title) });
      return;
    }
    if (o.videoWithContextRenderer || o.compactVideoRenderer) {
      var mr = o.videoWithContextRenderer || o.compactVideoRenderer;
      if (mr.videoId) mobile.push({ id: mr.videoId, title: textOf(mr.headline || mr.title) });
      return;
    }
    if (o.lockupViewModel) {
      var l = o.lockupViewModel;
      if (l.contentId && /VIDEO/.test(String(l.contentType || ''))) {
        var m = l.metadata && l.metadata.lockupMetadataViewModel;
        lockups.push({ id: l.contentId, title: textOf(m && m.title) });
      }
      return;
    }
    if (o.continuationItemRenderer) {
      var ce = o.continuationItemRenderer.continuationEndpoint;
      var tk = ce && ce.continuationCommand && ce.continuationCommand.token;
      if (tk) token = tk;
      return;
    }
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) walk(o[k]);
  })(root);
  var vids = main.length ? main : (lockups.length ? lockups : mobile);
  return { videos: vids, items: vids, token: token };
}
// Decodes the inside of a JavaScript string literal (\xNN, \uNNNN, \n, \\ ...).
function unescapeJsString(raw) {
  return String(raw).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, function (m, g) {
    if (g.charAt(0) === 'x' && g.length === 3) return String.fromCharCode(parseInt(g.slice(1), 16));
    if (g.charAt(0) === 'u' && g.length === 5) return String.fromCharCode(parseInt(g.slice(1), 16));
    var map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
    return Object.prototype.hasOwnProperty.call(map, g) ? map[g] : g;
  });
}
// Finds `ytInitialData = {...}` in a page's HTML and parses the JSON object (string-aware brace matching).
function extractJsonAssigned(html, name) {
  var pats = ['var ' + name + ' = ', 'window["' + name + '"] = ', name + ' = ', name + '='];
  var i = -1;
  for (var p = 0; p < pats.length && i < 0; p++) { i = html.indexOf(pats[p]); if (i >= 0) i += pats[p].length; }
  if (i < 0) return null;
  var jp = html.slice(i, i + 40).match(/^\s*JSON\.parse\(\s*(['"])/);
  if (jp) {
    var q0 = i + jp[0].length, quote = jp[1], raw = '', esc2 = false;
    for (var z = q0; z < html.length; z++) {
      var ch = html.charAt(z);
      if (esc2) { raw += '\\' + ch; esc2 = false; continue; }
      if (ch === '\\') { esc2 = true; continue; }
      if (ch === quote) break;
      raw += ch;
    }
    try { return JSON.parse(unescapeJsString(raw)); } catch (e0) { return null; }
  }
  var start = html.indexOf('{', i);
  if (start < 0) return null;
  var depth = 0, inStr = false, esc = false;
  for (var q = start; q < html.length; q++) {
    var c = html.charAt(q);
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, q + 1)); } catch (e) { return null; } } }
  }
  return null;
}


// ---- channel and playlist page helpers ----
function playlistTitle(data) {
  var m = data && data.metadata && data.metadata.playlistMetadataRenderer;
  var t = m ? textOf(m.title) : '';
  if (!t && data && data.microformat && data.microformat.microformatDataRenderer) t = textOf(data.microformat.microformatDataRenderer.title);
  return t;
}
function channelTitle(data) {
  var m = data && data.metadata && data.metadata.channelMetadataRenderer;
  return m ? textOf(m.title) : '';
}
function channelPlaylistsUrl(s) {
  s = String(s || '').trim();
  if (!s) throw new Error('Enter a channel link or @handle.');
  if (/^@[\w.\-]+$/.test(s)) return 'https://www.youtube.com/' + s + '/playlists';
  if (/^UC[\w-]{22}$/.test(s)) return 'https://www.youtube.com/channel/' + s + '/playlists';
  var m = s.match(/youtube\.com\/(@[\w.\-%]+|channel\/UC[\w-]{22}|c\/[\w.\-%]+|user\/[\w.\-%]+)/i);
  if (m) return 'https://www.youtube.com/' + m[1] + '/playlists';
  throw new Error('That does not look like a YouTube channel link. Try the @handle or the channel address.');
}
function findCount(o) {
  var found = '';
  (function w(x) {
    if (found || x == null) return;
    if (typeof x === 'string') { if (/^\d[\d,.]*\s+(videos?|episodes?)$/i.test(x.trim())) found = x.trim(); return; }
    if (typeof x !== 'object') return;
    for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) w(x[k]);
  })(o);
  return found;
}
// Playlists listed on a channel's Playlists tab (old and new YouTube layouts) plus the "load more" token.
function collectChannelPlaylists(root) {
  var items = [], seen = {}, token = null;
  function add(id, title, count) {
    if (!id || seen[id] || /^RD/.test(id)) return;
    seen[id] = 1;
    if (/^\d+$/.test(count)) count += ' videos';
    items.push({ id: id, title: title || id, count: count || '' });
  }
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i]); return; }
    if (o.gridPlaylistRenderer) { var g = o.gridPlaylistRenderer; add(g.playlistId, textOf(g.title), textOf(g.videoCountShortText) || textOf(g.videoCountText)); return; }
    if (o.playlistRenderer) { var p = o.playlistRenderer; add(p.playlistId, textOf(p.title), p.videoCount ? p.videoCount + ' videos' : ''); return; }
    if (o.lockupViewModel) {
      var l = o.lockupViewModel;
      if (/PLAYLIST/.test(String(l.contentType || ''))) {
        var m = l.metadata && l.metadata.lockupMetadataViewModel;
        add(l.contentId, textOf(m && m.title), findCount(l));
      }
      return;
    }
    if (o.continuationItemRenderer) {
      var ce = o.continuationItemRenderer.continuationEndpoint;
      var tk = ce && ce.continuationCommand && ce.continuationCommand.token;
      if (tk) token = tk;
      return;
    }
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) walk(o[k]);
  })(root);
  return { items: items, token: token };
}

// ---- saved lists: encoding, merging across devices ----
function clampInt(v, lo, hi, dflt) { v = Math.round(Number(v)); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; }
function clampNum(v, lo, hi, dflt) { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 100) / 100)) : dflt; }
function emptyStore() { return { v: 1, lists: [], deleted: {}, channels: [] }; }
function normList(L) {
  return {
    id: String(L.id), name: String(L.name || 'Untitled').slice(0, 80), source: String(L.source || '').slice(0, 200),
    created: Number(L.created) || 0, updated: Number(L.updated) || 0, loop: !!L.loop,
    defRepeats: clampInt(L.defRepeats, 1, 999, 1), defSpeed: clampNum(L.defSpeed, 0.25, 4, 1), data: String(L.data || '')
  };
}
// One line per video: [-]id,repeats,speed[,start[,end]]   (a leading "-" means unticked)
function encodeRows(rows) {
  return rows.map(function (r) {
    var f = [r.id, r.repeats, r.speed, r.start || '', r.end || ''];
    while (f.length > 3 && f[f.length - 1] === '') f.pop();
    return (r.on === false ? '-' : '') + f.join(',');
  }).join('\n');
}
function decodeRows(s) {
  var out = [];
  String(s || '').split('\n').forEach(function (line) {
    line = line.trim();
    if (!line) return;
    var on = true;
    if (line.charAt(0) === '-') { on = false; line = line.slice(1); }
    var p = line.split(',');
    if (!/^[A-Za-z0-9_-]{11}$/.test(p[0])) return;
    out.push({ id: p[0], on: on, repeats: Number(p[1]) || 1, speed: Number(p[2]) || 1, start: p[3] || '', end: p[4] || '' });
  });
  return out;
}
function listToPayload(L) { return JSON.stringify({ n: L.name, s: L.source, c: L.created, u: L.updated, l: L.loop ? 1 : 0, r: L.defRepeats, p: L.defSpeed, d: L.data }); }
function payloadToList(id, text) {
  try {
    var o = JSON.parse(text);
    if (!o || typeof o.d !== 'string') return null;
    return normList({ id: id, name: o.n, source: o.s, created: o.c, updated: o.u, loop: o.l === 1, defRepeats: o.r, defSpeed: o.p, data: o.d });
  } catch (e) { return null; }
}
function chunkString(s, max) {
  var out = [];
  for (var i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out.length ? out : [''];
}
// Newer copy of each list wins; deletions are remembered so a deleted list does not come back from another device.
function mergeStores(a, b) {
  a = a || emptyStore(); b = b || emptyStore();
  var deleted = {};
  [a.deleted, b.deleted].forEach(function (d) { Object.keys(d || {}).forEach(function (k) { deleted[k] = Math.max(deleted[k] || 0, Number(d[k]) || 0); }); });
  var map = {};
  [a, b].forEach(function (s) {
    (s.lists || []).forEach(function (L) {
      var n = normList(L), x = map[n.id];
      if (!x || n.updated > x.updated) map[n.id] = n;
    });
  });
  var lists = [];
  Object.keys(map).forEach(function (id) { if ((deleted[id] || 0) < map[id].updated) lists.push(map[id]); });
  lists.sort(function (x, y) { return x.created - y.created || (x.id < y.id ? -1 : 1); });
  var keys = Object.keys(deleted).sort(function (x, y) { return deleted[y] - deleted[x]; }).slice(0, 60), del = {};
  keys.sort().forEach(function (k) { del[k] = deleted[k]; });
  var channels = [], seen = {};
  (a.channels || []).concat(b.channels || []).forEach(function (c) {
    if (c && typeof c.url === 'string' && !seen[c.url] && channels.length < 10) { seen[c.url] = 1; channels.push({ url: c.url.slice(0, 120), name: String(c.name || '').slice(0, 60) }); }
  });
  return { v: 1, lists: lists, deleted: del, channels: channels };
}
// Checks a backup pasted or loaded by the user before it is merged in.
function sanitizeStore(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.lists)) throw new Error('That is not a backup from this extension.');
  var s = emptyStore();
  o.lists.slice(0, 200).forEach(function (L) {
    if (!L || typeof L.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(L.id) || typeof L.data !== 'string' || L.data.length > 200000) return;
    s.lists.push(normList(L));
  });
  if (Array.isArray(o.channels)) s.channels = o.channels.filter(function (c) { return c && typeof c.url === 'string'; }).slice(0, 10);
  return s;
}
