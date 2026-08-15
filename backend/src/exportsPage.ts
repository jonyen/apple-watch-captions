/**
 * Single-file "where do my transcripts go" page, served at /app/exports.
 * Same shape as viewerPage.ts: a device token kept in localStorage under
 * `wc_token`, and every data call sending it as `Authorization: Bearer`.
 */
export const EXPORTS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch Captions — Export Destinations</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0; padding: 1.5rem; max-width: 760px; margin-inline: auto;
    background: Canvas; color: CanvasText;
  }
  h1 { font-size: 1.3rem; margin: 0 0 .3rem; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
  a.back { font-size: .85rem; }
  .card {
    border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
    border-radius: 10px; padding: .8rem 1rem; margin-bottom: .6rem;
  }
  .meta { font-size: .82rem; opacity: .65; }
  .badge { font-size: .72rem; border: 1px solid currentColor; border-radius: 99px;
    padding: 0 .5em; margin-left: .5em; opacity: .7; }
  .badge.pending { color: #b58900; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  button, input {
    font: inherit; padding: .45rem .8rem; border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas);
    background: Canvas; color: CanvasText;
  }
  a.button {
    display: inline-block; text-decoration: none; font: inherit;
    padding: .45rem .8rem; border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas);
    color: CanvasText;
  }
  input { width: 100%; margin-bottom: .6rem; }
  .banner { border-radius: 8px; padding: .7rem 1rem; margin-bottom: 1rem; font-size: .92rem; }
  .banner.ok { border: 1px solid #2a2; }
  .banner.warn { border: 1px solid #c93; }
  .banner.error { border: 1px solid #c33; }
  .notice { font-size: .85rem; opacity: .8; border-left: 3px solid color-mix(in srgb, CanvasText 30%, Canvas);
    padding-left: .8rem; margin: .6rem 0 1rem; }
  .error { color: #c33; }
</style>
</head>
<body>
<p><a class="back" href="/app">&larr; Transcripts</a></p>
<h1>Export Destinations</h1>
<div id="banner"></div>
<div id="auth" style="display:none">
  <p>Enter your device token to manage export destinations.</p>
  <input id="token" type="password" placeholder="device token" autocomplete="off">
  <button id="save">Save</button>
</div>
<div id="content"></div>

<h2>Notion</h2>
<div id="notion"></div>

<h2>Email</h2>
<p class="notice">
  Email delivery sends the <strong>full transcript</strong> of a finished session
  to the address below, automatically, once each session ends — including
  anything other people said, not just your own side of the conversation.
  Only give an address you are comfortable receiving that.
</p>
<div id="email"></div>

<script>
let token = localStorage.getItem('wc_token') || '';
const authBox = document.getElementById('auth');
const banner = document.getElementById('banner');
const notionBox = document.getElementById('notion');
const emailBox = document.getElementById('email');

document.getElementById('save').onclick = () => {
  token = document.getElementById('token').value.trim();
  localStorage.setItem('wc_token', token);
  load();
};

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts && opts.headers), authorization: 'Bearer ' + token },
  });
  if (res.status === 401) { authBox.style.display = 'block'; throw new Error('unauthorized'); }
  authBox.style.display = 'none';
  return res;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The two OAuth/confirmation callbacks redirect the browser back here with a
// query parameter instead of a response body, since neither has a fetch
// caller to hand a result to — they are followed from Notion's consent
// screen or an email inbox. Read once on load and shown as a banner.
function showBanner() {
  const params = new URLSearchParams(location.search);
  const notion = params.get('notion');
  const email = params.get('email');
  const messages = {
    notion: {
      connected: ['ok', 'Notion connected.'],
      denied: ['warn', 'Notion connection cancelled — you clicked Cancel on the consent screen.'],
      nodatabase: ['warn', 'Notion connected, but no database was shared with the integration. Share a database with it in Notion, then connect again.'],
      failed: ['error', 'Could not connect Notion. Try again.'],
    },
    email: {
      confirmed: ['ok', 'Email address confirmed — transcripts will be sent there from now on.'],
      failed: ['error', 'That confirmation link is invalid or has expired.'],
    },
  };
  const pick = (kind, value) => (value && messages[kind][value]) || null;
  const shown = pick('notion', notion) || pick('email', email);
  if (shown) {
    const [level, text] = shown;
    banner.append(el('div', 'banner ' + level, text));
  }
  if (notion || email) {
    // Strip the param so a reload doesn't re-show a stale banner.
    history.replaceState(null, '', location.pathname);
  }
}

async function loadNotion() {
  notionBox.textContent = '';
  const list = (await (await api('/v1/exports')).json()).destinations;
  const notion = list.find((d) => d.kind === 'notion');
  const card = el('div', 'card');
  if (notion) {
    const row = el('div', 'row');
    const left = el('div');
    left.append(el('strong', '', notion.detail));
    if (!notion.connected) left.append(el('span', 'badge pending', 'needs reconnect'));
    row.append(left);
    const disconnect = el('button', '', 'Disconnect');
    disconnect.onclick = async () => {
      await api('/v1/exports/notion', { method: 'DELETE' });
      loadNotion();
    };
    row.append(disconnect);
    card.append(row);
  } else {
    card.append(el('p', 'meta', 'Not connected. Finished transcripts are not sent to Notion.'));
    // Top-level navigation — a normal <a> click, not a fetch — so there is no
    // request this script controls and thus no way to attach an
    // Authorization header. The device token travels in the query string
    // instead; principalFor() already falls back to reading it from there.
    // This is the one place in the app a device token appears in a URL
    // (and so the one place it can land in browser history or a proxy log)
    // — every other call here uses the header. Kept to this single
    // unavoidable spot rather than adopted more broadly.
    const connect = el('a', 'button', 'Connect Notion');
    connect.href = '/v1/exports/notion/start?token=' + encodeURIComponent(token);
    // Cheap extra guard on top of the above, given the token is in this URL:
    // stops the browser from sending this page's URL as a Referer to
    // whatever the relay's 302 redirects on to.
    connect.rel = 'noreferrer';
    card.append(connect);
  }
  notionBox.append(card);
}

async function loadEmail() {
  emailBox.textContent = '';
  const list = (await (await api('/v1/exports')).json()).destinations;
  const email = list.find((d) => d.kind === 'email');
  const card = el('div', 'card');
  if (email) {
    const row = el('div', 'row');
    const left = el('div');
    left.append(el('strong', '', email.detail));
    if (!email.connected) left.append(el('span', 'badge pending', 'unconfirmed — check your inbox'));
    row.append(left);
    const disconnect = el('button', '', 'Disconnect');
    disconnect.onclick = async () => {
      await api('/v1/exports/email', { method: 'DELETE' });
      loadEmail();
    };
    row.append(disconnect);
    card.append(row);
  } else {
    card.append(el('p', 'meta', 'Not connected. Finished transcripts are not emailed.'));
    const input = el('input');
    input.type = 'email';
    input.placeholder = 'you@example.com';
    card.append(input);
    const submit = el('button', '', 'Send confirmation link');
    const status = el('p', 'meta');
    submit.onclick = async () => {
      status.textContent = 'Sending…';
      status.className = 'meta';
      try {
        const res = await api('/v1/exports/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: input.value.trim() }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'request failed: ' + res.status);
        }
        status.textContent = 'Confirmation link sent — click it to start receiving transcripts.';
        status.className = '';
      } catch (e) {
        status.textContent = e.message;
        status.className = 'error';
      }
    };
    card.append(submit);
    card.append(status);
  }
  emailBox.append(card);
}

async function load() {
  try {
    await loadNotion();
    await loadEmail();
  } catch (e) {
    if (e.message !== 'unauthorized') {
      document.getElementById('content').replaceChildren(el('p', 'error', e.message));
    }
  }
}

showBanner();
if (!token) authBox.style.display = 'block';
else load();
</script>
</body>
</html>
`;
