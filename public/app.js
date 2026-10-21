const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
let timer = null, draft = null, busy = false, flash = '', last = '';

/* delete tokens for tournaments created in this browser */
const tokens = () => { try { return JSON.parse(localStorage.getItem('gotaTokens') || '{}'); } catch (e) { return {}; } };
const setToken = (id, t) => { try { const k = tokens(); k[id] = t; localStorage.setItem('gotaTokens', JSON.stringify(k)); } catch (e) {} };

const adminKey = () => { try { return localStorage.getItem('gotaAdmin') || ''; } catch (e) { return ''; } };
const canEdit = id => !!tokens()[id] || !!adminKey();
const auth = id => ({ 'x-admin-key': adminKey(), 'x-delete-token': tokens()[id] || '' });

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
const hdr = sub => `<header><h1>Tournaments</h1><div class="row">${sub || ''}</div></header>`;
const editBtn = id => canEdit(id) ? btn('Edit', '#/t/' + id + '/edit') : '';
const btn = (label, href, cls = '') => `<a href="${href}"><button class="${cls}">${label}</button></a>`;

/* ---------- images: square crop, 320px JPEG ---------- */
function shrink(file, n = 320) {
  return new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = n;
        const s = Math.min(im.width, im.height);
        c.getContext('2d').drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, n, n);
        res(c.toDataURL('image/jpeg', 0.8));
      };
      im.onerror = () => res(null); im.src = fr.result;
    };
    fr.onerror = () => res(null); fr.readAsDataURL(file);
  });
}

/* ---------- routing ---------- */
function route() {
  clearInterval(timer);
  const h = location.hash.replace(/^#\/?/, '').split('/');
  if (h[0] === 'owner') { const k = prompt('Owner key:'); if (k) { try { localStorage.setItem('gotaAdmin', k.trim()); } catch (e) {} } location.hash = '#/'; return; }
  if (h[0] === 'owner-off') { try { localStorage.removeItem('gotaAdmin'); } catch (e) {} location.hash = '#/'; return; }
  if (h[0] === 'new') return showCreate();
  if (h[0] === 't' && h[1]) return h[2] === 'edit' ? showEdit(h[1]) : h[2] === 'board' ? showBoard(h[1]) : showPlay(h[1]);
  return showHome();
}
window.addEventListener('hashchange', route);

/* ---------- home ---------- */
async function showHome() {
  const newBtn = btn('+ New tournament', '#/new', 'p');
  app.innerHTML = hdr(newBtn) + '<div class="card mute">Loading…</div>';
  try {
    const list = (await api('/tournaments')).sort((x, y) => y.votes - x.votes || y.createdAt - x.createdAt);
    const mine = tokens();
    app.innerHTML = hdr(newBtn) + (list.length ? `<div class="tgrid">${list.map(t => `
      <div class="tcard">
        <h3 title="${esc(t.name)}">${esc(t.name)}</h3>
        ${t.hasCover ? `<img class="tcover" src="/cover/${t.id}" alt="">` : '<div class="tcover none">No image</div>'}
        <div class="mute tmeta">${t.n} entries &middot; ${t.votes} votes</div>
        <div class="tbtns">${btn('Vote', '#/t/' + t.id, 'p')}${btn('Leaderboard', '#/t/' + t.id + '/board')}${canEdit(t.id) ? btn('Edit', '#/t/' + t.id + '/edit') + `<button class="d" data-del="${t.id}">Delete</button>` : ''}</div>
      </div>`).join('')}</div>` : '<div class="card mute">No tournaments yet. Be the first to create one.</div>');
    app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this tournament for everyone?')) return;
      try { await api('/tournaments/' + b.dataset.del, { method: 'DELETE', headers: auth(b.dataset.del) }); showHome(); }
      catch (e) { alert(e.message); }
    });
  } catch (e) { app.innerHTML = hdr() + `<div class="note">${esc(e.message)}</div>`; }
}

/* ---------- create ---------- */
function showCreate() {
  if (!draft) draft = { name: '', cover: null, items: [] };
  const ok = draft.items.length >= 2 && draft.name.trim() && !busy;
  app.innerHTML = hdr(btn('Cancel', '#/')) + `<div class="card"><h2>Create tournament</h2>
    <input type="text" id="tname" maxlength="80" placeholder="Tournament name (e.g. Best Pizza Topping)" value="${esc(draft.name)}">
    <div class="row" style="margin-top:12px"><label class="btn">Tournament image (optional)<input type="file" id="cfile" accept="image/*" hidden></label>
    ${draft.cover ? `<img class="cprev" src="${draft.cover}" alt=""><button class="d" id="crm">Remove</button>` : ''}</div>
    <div class="row" style="margin-top:12px"><label class="btn">Upload images<input type="file" id="files" accept="image/*" multiple hidden></label>
    <span class="mute">Names default to filenames; edit them below. 2 to 40 entries. Visible to everyone.</span></div>
    <div class="items">${draft.items.map(i => `<div class="it"><img src="${i.img}" alt=""><div class="in">
      <input type="text" maxlength="80" data-name="${i.id}" value="${esc(i.name)}">
      <button class="d" style="width:100%;margin-top:4px;padding:3px" data-rm="${i.id}">Remove</button></div></div>`).join('')}</div>
    <button class="p" id="save" ${ok ? '' : 'disabled'}>${busy ? 'Saving…' : 'Publish tournament (' + draft.items.length + ')'}</button></div>`;
  const check = () => { document.getElementById('save').disabled = !(draft.items.length >= 2 && draft.name.trim()); };
  document.getElementById('tname').oninput = e => { draft.name = e.target.value; check(); };
  document.getElementById('cfile').onchange = async e => { const f = e.target.files[0]; if (f && f.type.startsWith('image/')) { const img = await shrink(f, 480); if (img) { draft.cover = img; showCreate(); } } };
  const crm = document.getElementById('crm'); if (crm) crm.onclick = () => { draft.cover = null; showCreate(); };
  document.getElementById('files').onchange = async e => {
    for (const f of e.target.files) {
      if (!f.type.startsWith('image/') || draft.items.length >= 40) continue;
      const img = await shrink(f);
      if (img) draft.items.push({ id: uid(), name: f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), img });
    }
    showCreate();
  };
  app.querySelectorAll('[data-name]').forEach(el => el.oninput = e => { draft.items.find(i => i.id === el.dataset.name).name = e.target.value; });
  app.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { draft.items = draft.items.filter(i => i.id !== b.dataset.rm); showCreate(); });
  document.getElementById('save').onclick = async () => {
    busy = true; showCreate();
    try {
      const r = await api('/tournaments', { method: 'POST', body: { name: draft.name, cover: draft.cover, items: draft.items.map(({ name, img }) => ({ name, img })) } });
      setToken(r.id, r.deleteToken); draft = null; busy = false; location.hash = '#/t/' + r.id;
    } catch (e) { busy = false; alert(e.message); showCreate(); }
  };
}

/* ---------- play ---------- */
async function showPlay(id, keepFlash) {
  if (!keepFlash) flash = '';
  try {
    const d = await api('/tournaments/' + id + '/pair?last=' + encodeURIComponent(last));
    app.innerHTML = hdr(btn('Leaderboard', '#/t/' + id + '/board') + editBtn(id)) + `<h2 style="margin-bottom:6px">${esc(d.name)}</h2><div class="mute">Pick the one you prefer.</div>` +
      (d.pair ? `<div class="vs">${d.pair.map((p, n) => `<button class="card opt" data-n="${n}"><img src="/img/${p.id}" alt=""><span>${esc(p.name)}</span></button>`).join('<div class="vsb">vs</div>')}</div>`
        : '<div class="card mute">This tournament needs at least 2 entries.</div>') +
      `<div class="flash">${flash}</div><div class="row" style="justify-content:center"><button id="skip">Skip pair</button></div>`;
    document.getElementById('skip').onclick = () => showPlay(id);
    app.querySelectorAll('.opt').forEach(b => b.onclick = async () => {
      const w = d.pair[+b.dataset.n], l = d.pair[1 - b.dataset.n];
      app.querySelectorAll('.opt').forEach(x => x.disabled = true);
      try {
        const r = await api('/tournaments/' + id + '/vote', { method: 'POST', body: { winner: w.id, loser: l.id } });
        last = [w.id, l.id].sort().join();
        flash = `<b>${esc(r.winner.name)}</b> <span class="up">+${r.winner.delta}</span> &middot; ${esc(r.loser.name)} <span class="dn">${r.loser.delta}</span>`;
      } catch (e) { flash = `<span class="dn">${esc(e.message)}</span>`; }
      showPlay(id, true);
    });
  } catch (e) { app.innerHTML = hdr() + `<div class="note">${esc(e.message)}</div>`; }
}

/* ---------- leaderboard (auto-refreshes) ---------- */
async function showBoard(id) {
  const draw = async () => {
    try {
      const t = await api('/tournaments/' + id);
      app.innerHTML = hdr(btn('Vote', '#/t/' + id, 'p') + editBtn(id)) + `<div class="card"><h2>${esc(t.name)}: Leaderboard</h2>
        <div class="mute" style="margin-bottom:8px">${t.votes} votes cast by everyone so far. Updates live. Share this page's link to get more votes.</div>
        <div class="tw"><table><tr><th>#</th><th>Entry</th><th>Elo</th><th>W</th><th>L</th><th>Win%</th></tr>
        ${t.items.map((i, n) => { const g = i.w + i.l; return `<tr class="${n === 0 ? 'gold' : ''}"><td class="rk">${n + 1}</td>
          <td><img src="/img/${i.id}" alt="">${esc(i.name)}</td><td><span class="badge">${i.elo}</span></td><td>${i.w}</td><td>${i.l}</td><td>${g ? Math.round(100 * i.w / g) + '%' : '–'}</td></tr>`; }).join('')}
        </table></div></div>`;
    } catch (e) { app.innerHTML = hdr() + `<div class="note">${esc(e.message)}</div>`; clearInterval(timer); }
  };
  await draw(); timer = setInterval(draw, 5000);
}

/* ---------- edit (creator only): rename + add entries, keeps all votes and Elo ---------- */
let ed = null;
async function showEdit(id) {
  if (!canEdit(id)) { app.innerHTML = hdr() + '<div class="note">Only the browser that created this tournament can edit it.</div>'; return; }
  if (!ed || ed.id !== id) {
    app.innerHTML = hdr() + '<div class="card mute">Loading…</div>';
    try {
      const t = await api('/tournaments/' + id);
      ed = { id, name: t.name, items: t.items.map(i => ({ id: i.id, name: i.name })), added: [], hasCover: !!t.hasCover, cover: null, removeCover: false };
    } catch (e) { app.innerHTML = hdr() + `<div class="note">${esc(e.message)}</div>`; return; }
  }
  drawEdit();
}
function drawEdit() {
  const total = ed.items.length + ed.added.length;
  const prev = ed.cover || (ed.hasCover && !ed.removeCover ? '/cover/' + ed.id : null);
  app.innerHTML = hdr(btn('Cancel', '#/t/' + ed.id + '/board')) + `<div class="card"><h2>Edit tournament</h2>
    <div class="mute" style="margin-bottom:8px">Existing entries keep their Elo, wins and losses. New entries start at 1000.</div>
    <input type="text" id="ename" maxlength="80" value="${esc(ed.name)}">
    <div class="row" style="margin-top:12px"><label class="btn">${prev ? 'Change tournament image' : 'Add tournament image'}<input type="file" id="ecfile" accept="image/*" hidden></label>
    ${prev ? `<img class="cprev" src="${prev}" alt=""><button class="d" id="ecrm">Remove</button>` : ''}</div>
    <div class="row" style="margin-top:12px"><label class="btn">Add images<input type="file" id="efiles" accept="image/*" multiple hidden></label>
    <span class="mute">${total} of 40 entries</span></div>
    <div class="items">
      ${ed.items.map(i => `<div class="it"><img src="/img/${i.id}" alt=""><div class="in"><input type="text" maxlength="80" data-ex="${i.id}" value="${esc(i.name)}"></div></div>`).join('')}
      ${ed.added.map(i => `<div class="it"><img src="${i.img}" alt=""><div class="in"><input type="text" maxlength="80" data-new="${i.id}" value="${esc(i.name)}">
        <button class="d" style="width:100%;margin-top:4px;padding:3px" data-rm="${i.id}">Remove</button></div></div>`).join('')}
    </div>
    <button class="p" id="esave" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save changes'}</button></div>`;
  document.getElementById('ename').oninput = e => { ed.name = e.target.value; };
  document.getElementById('ecfile').onchange = async e => { const f = e.target.files[0]; if (f && f.type.startsWith('image/')) { const img = await shrink(f, 480); if (img) { ed.cover = img; ed.removeCover = false; drawEdit(); } } };
  const ecrm = document.getElementById('ecrm'); if (ecrm) ecrm.onclick = () => { ed.cover = null; ed.removeCover = true; drawEdit(); };
  document.getElementById('efiles').onchange = async e => {
    for (const f of e.target.files) {
      if (!f.type.startsWith('image/') || ed.items.length + ed.added.length >= 40) continue;
      const img = await shrink(f);
      if (img) ed.added.push({ id: uid(), name: f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), img });
    }
    drawEdit();
  };
  app.querySelectorAll('[data-ex]').forEach(el => el.oninput = e => { ed.items.find(i => i.id === el.dataset.ex).name = e.target.value; });
  app.querySelectorAll('[data-new]').forEach(el => el.oninput = e => { ed.added.find(i => i.id === el.dataset.new).name = e.target.value; });
  app.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { ed.added = ed.added.filter(i => i.id !== b.dataset.rm); drawEdit(); });
  document.getElementById('esave').onclick = async () => {
    if (!ed.name.trim()) return alert('Give the tournament a name.');
    busy = true; drawEdit();
    try {
      await api('/tournaments/' + ed.id, { method: 'PUT', headers: auth(ed.id),
        body: { name: ed.name, cover: ed.cover, removeCover: ed.removeCover, rename: ed.items, add: ed.added.map(({ name, img }) => ({ name, img })) } });
      const id = ed.id; ed = null; busy = false; location.hash = '#/t/' + id + '/board';
    } catch (e) { busy = false; alert(e.message); drawEdit(); }
  };
}

route();