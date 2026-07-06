/**
 * Single-file transcript viewer served at /app. Talks to /v1/transcripts with
 * the relay auth token, which the user pastes once (kept in localStorage).
 */
export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch Captions — Transcripts</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0; padding: 1.5rem; max-width: 760px; margin-inline: auto;
    background: Canvas; color: CanvasText;
  }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
  .card {
    border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
    border-radius: 10px; padding: .8rem 1rem; margin-bottom: .6rem;
    cursor: pointer;
  }
  .card:hover { border-color: color-mix(in srgb, CanvasText 40%, Canvas); }
  .meta { font-size: .82rem; opacity: .65; }
  .preview { margin: .25rem 0 0; font-size: .9rem; opacity: .85;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: .72rem; border: 1px solid currentColor; border-radius: 99px;
    padding: 0 .5em; margin-left: .5em; opacity: .7; }
  #summary { white-space: pre-wrap; border-left: 3px solid color-mix(in srgb, CanvasText 30%, Canvas);
    padding-left: .8rem; }
  .seg { margin: .35rem 0; }
  .seg time { font-size: .75rem; opacity: .55; margin-right: .6em; font-variant-numeric: tabular-nums; }
  button, input {
    font: inherit; padding: .45rem .8rem; border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas);
    background: Canvas; color: CanvasText;
  }
  input { width: 100%; margin-bottom: .6rem; }
  #back { margin-bottom: 1rem; display: none; }
  .error { color: #c33; }
</style>
</head>
<body>
<h1>Watch Captions — Transcripts</h1>
<div id="auth" style="display:none">
  <p>Enter the relay auth token to view transcripts.</p>
  <input id="token" type="password" placeholder="auth token" autocomplete="off">
  <button id="save">Save</button>
</div>
<button id="back">&larr; All transcripts</button>
<div id="content"></div>
<script>
const content = document.getElementById('content');
const authBox = document.getElementById('auth');
const backBtn = document.getElementById('back');
let token = localStorage.getItem('wc_token') || '';

document.getElementById('save').onclick = () => {
  token = document.getElementById('token').value.trim();
  localStorage.setItem('wc_token', token);
  showList();
};
backBtn.onclick = showList;

async function api(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(path + sep + 'token=' + encodeURIComponent(token));
  if (res.status === 401) { authBox.style.display = 'block'; throw new Error('unauthorized'); }
  if (!res.ok) throw new Error('request failed: ' + res.status);
  authBox.style.display = 'none';
  return res.json();
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

async function showList() {
  backBtn.style.display = 'none';
  content.textContent = 'Loading…';
  try {
    const data = await api('/v1/transcripts');
    content.textContent = '';
    if (data.transcripts.length === 0) {
      content.append(el('p', 'meta', 'No transcripts yet. Run a captioning session on the watch.'));
      return;
    }
    for (const t of data.transcripts) {
      const card = el('div', 'card');
      const head = el('div');
      head.append(el('strong', '', fmt(t.startedAt)));
      head.append(el('span', 'meta', ' · ' + t.segmentCount + ' captions'));
      if (t.hasSummary) head.append(el('span', 'badge', 'summary'));
      card.append(head);
      card.append(el('p', 'preview', t.preview || '(empty)'));
      card.onclick = () => showDetail(t.name);
      content.append(card);
    }
  } catch (e) {
    if (e.message !== 'unauthorized') content.replaceChildren(el('p', 'error', e.message));
    else content.textContent = '';
  }
}

async function showDetail(name) {
  content.textContent = 'Loading…';
  try {
    const t = await api('/v1/transcripts/' + encodeURIComponent(name));
    backBtn.style.display = 'inline-block';
    content.textContent = '';
    if (t.summary) {
      content.append(el('h2', '', 'Summary'));
      content.append(el('div', '', '')).id = 'summary';
      document.getElementById('summary').textContent = t.summary;
    } else {
      content.append(el('p', 'meta', 'No summary yet (generated shortly after the session ends).'));
    }
    content.append(el('h2', '', 'Transcript'));
    for (const s of t.segments) {
      const row = el('div', 'seg');
      const time = document.createElement('time');
      time.textContent = new Date(s.at).toLocaleTimeString();
      row.append(time);
      if (s.channel === 0) row.append(el('strong', '', 'Me: '));
      else if (s.channel === 1) row.append(el('strong', '', 'Them: '));
      row.append(document.createTextNode(s.text));
      content.append(row);
    }
  } catch (e) {
    content.replaceChildren(el('p', 'error', e.message));
  }
}

if (!token) authBox.style.display = 'block';
else showList();
</script>
</body>
</html>
`;
