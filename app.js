/* 先生の予定ノート — 端末内保存（IndexedDB）の個人用予定・準備管理アプリ */
'use strict';

const APP_VERSION = '1.0.2';
const CATS = ['国語', '道徳', '学級・学年', '校務'];
const KINDS = ['行事', '授業', '締切'];
const CAT_CLASS = { '国語': 'c-kokugo', '道徳': 'c-doutoku', '学級・学年': 'c-gakkyu', '校務': 'c-koumu' };
const KIND_CLASS = { '締切': 'k-shime' };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const PDFJS_BASE = ''; // PDF表示ライブラリ（pdf.js、無料・同梱）

/* ---------- 小道具 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n) => String(n).padStart(2, '0');

/* ---------- 日付（'YYYY-MM-DD' 文字列で扱う） ---------- */
const toStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => toStr(new Date());
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return toStr(d); };
const diffDays = (a, b) => Math.round((parseD(a) - parseD(b)) / 86400000); // a − b
const dow = (s) => parseD(s).getDay();
const weekStart = (s) => addDays(s, -((dow(s) + 6) % 7)); // 月曜はじまり
const fy = (s) => { const [y, m] = s.split('-').map(Number); return m >= 4 ? y : y - 1; }; // 年度（4月〜翌3月）
const fyLabel = (y) => `${y}年度`;
const fmtMD = (s) => { const [, m, d] = s.split('-').map(Number); return `${m}/${d}（${WD[dow(s)]}）`; };
const fmtFull = (s) => { const [y, m, d] = s.split('-').map(Number); return `${y}年${m}月${d}日（${WD[dow(s)]}）`; };
const isValidDate = (y, m, d) => { const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; };
const offsetLabel = (o) => (o == null ? '' : o > 0 ? `行事の${o}日前` : o === 0 ? '行事の当日' : `行事の${-o}日後`);

/* ---------- データベース ---------- */
const STORES = ['events', 'preps', 'attachments', 'notes', 'blobs', 'meta'];
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sensei-note', 1);
      r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  all(s) { return this.tx(s, 'readonly', (st) => st.getAll()); },
  get(s, id) { return this.tx(s, 'readonly', (st) => st.get(id)); },
  put(s, o) { return this.tx(s, 'readwrite', (st) => st.put(o)); },
  del(s, id) { return this.tx(s, 'readwrite', (st) => st.delete(id)); },
  clear(s) { return this.tx(s, 'readwrite', (st) => st.clear()); },
  putMany(s, arr) { return this.tx(s, 'readwrite', (st) => { arr.forEach((o) => st.put(o)); }); },
};

// 画面表示用に、資料本体（blobs）以外はメモリにも持つ
const S = { events: new Map(), preps: new Map(), attachments: new Map(), notes: new Map(), meta: new Map() };
async function loadAll() {
  for (const k of ['events', 'preps', 'attachments', 'notes', 'meta']) {
    const rows = await DB.all(k);
    S[k] = new Map(rows.map((r) => [r.id, r]));
  }
}
let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* 非対応 */ }
}
async function save(store, obj) {
  if (store !== 'meta') { obj.updatedAt = Date.now(); askPersist(); }
  S[store].set(obj.id, obj);
  try { await DB.put(store, obj); } catch (e) { console.error(e); toast('保存に失敗しました（容量不足の可能性）'); throw e; }
}
async function removeRec(store, id) { S[store].delete(id); await DB.del(store, id); }
const getMeta = (k) => S.meta.get(k)?.value;
const setMeta = (k, value) => save('meta', { id: k, value });

/* ---------- 取り出し ---------- */
const evList = () => [...S.events.values()];
const prepList = () => [...S.preps.values()];
const byTime = (a, b) => (a.startTime || '99').localeCompare(b.startTime || '99') || (a.title || '').localeCompare(b.title || '', 'ja');
const eventsOn = (d) => evList().filter((e) => e.date === d).sort(byTime);
const prepsDueOn = (d) => prepList().filter((p) => p.due === d).sort((a, b) => a.done - b.done || a.createdAt - b.createdAt);
const prepsOf = (id) => prepList().filter((p) => p.eventId === id).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.createdAt - b.createdAt);
const attsOf = (id) => [...S.attachments.values()].filter((a) => a.eventId === id).sort((a, b) => a.createdAt - b.createdAt);
const notesOf = (attId) => [...S.notes.values()].filter((n) => n.attachmentId === attId).sort((a, b) => (a.page || 0) - (b.page || 0) || a.createdAt - b.createdAt);
const overduePreps = () => { const t = today(); return prepList().filter((p) => !p.done && p.due && p.due < t).sort((a, b) => a.due.localeCompare(b.due)); };
const isOverdue = (p) => !p.done && p.due && p.due < today();

function newEvent(f = {}) {
  return { id: uid(), title: '', date: null, startTime: '', endTime: '', place: '', category: '', kind: '行事', memo: '', handover: '', sourceId: null, createdAt: Date.now(), ...f };
}
function newPrep(f = {}) {
  return { id: uid(), eventId: null, title: '', due: null, offset: null, done: false, createdAt: Date.now(), ...f };
}

// 期限と行事日から「何日前か」を計算し直す
async function recalcOffsets(ev) {
  for (const p of prepsOf(ev.id)) {
    if (ev.date && p.due) {
      const o = diffDays(ev.date, p.due);
      if (o !== p.offset) { p.offset = o; await save('preps', p); }
    } else if (ev.date && !p.due && p.offset != null) {
      p.due = addDays(ev.date, -p.offset); await save('preps', p);
    }
  }
}

/* ---------- 表示の部品 ---------- */
const catBadge = (c) => (c ? `<span class="badge ${CAT_CLASS[c] || ''}">${esc(c)}</span>` : '');
const kindBadge = (k) => (k && k !== '行事' ? `<span class="badge kind ${KIND_CLASS[k] || ''}">${esc(k)}</span>` : '');

function eventRow(ev, o = {}) {
  const time = ev.startTime ? `${ev.startTime}${ev.endTime ? '〜' + ev.endTime : ''}` : '';
  const ps = prepsOf(ev.id);
  const undone = ps.filter((p) => !p.done).length;
  const sub = [o.showDate && ev.date ? fmtMD(ev.date) : '', time, ev.place ? '場所：' + esc(ev.place) : ''].filter(Boolean).join('　');
  return `<button class="item ev ${CAT_CLASS[ev.category] || ''} ${KIND_CLASS[ev.kind] || ''}" data-go="#/event/${ev.id}">
    <span class="item-main"><span class="ttl">${esc(ev.title || '（無題）')}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span>
    <span class="badges">${catBadge(ev.category)}${kindBadge(ev.kind)}${ps.length ? `<span class="badge preps">準備 残${undone}</span>` : ''}</span>
  </button>`;
}

function prepRow(p, o = {}) {
  const ev = S.events.get(p.eventId);
  const od = isOverdue(p);
  const sub = [
    o.showDate && p.due ? `期限 ${fmtMD(p.due)}${od ? `（${diffDays(today(), p.due)}日過ぎ）` : ''}` : '',
    ev ? `→ ${esc(ev.title || '（無題）')}${ev.date ? `（${fmtMD(ev.date)}）` : ''}` : '',
  ].filter(Boolean).join('　');
  return `<div class="item prep ${p.done ? 'done' : ''} ${od ? 'overdue' : ''}">
    <label class="chk"><input type="checkbox" data-act="toggle-prep" data-id="${p.id}" ${p.done ? 'checked' : ''} aria-label="「${esc(p.title)}」を完了にする"></label>
    <button class="item-main" data-go="#/event/${p.eventId}"><span class="ttl"><span class="badge prepb">準備</span>${esc(p.title)}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</button>
  </div>`;
}

/* ---------- 週表示 ---------- */
function viewWeek(q) {
  const t = today();
  const ws = weekStart(q.get('d') || t);
  const we = addDays(ws, 6);
  const isThis = weekStart(t) === ws;
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  const weekPreps = prepList().filter((p) => p.due && p.due >= ws && p.due <= we);
  const weekEvents = evList().filter((e) => e.date && e.date >= ws && e.date <= we);
  const od = overduePreps();
  const [y1, m1, d1] = ws.split('-').map(Number);
  const [, m2, d2] = we.split('-').map(Number);

  let h = `<div class="viewhead">
    <button class="navbtn" data-go="#/week?d=${addDays(ws, -7)}" aria-label="前の週">◀</button>
    <div class="vh-title"><div class="vh-main">${y1}年 ${m1}/${d1}（月）〜 ${m2}/${d2}（日）</div>
      ${isThis ? '<div class="vh-sub">今週</div>' : '<button class="linkbtn" data-go="#/week">今週へ戻る</button>'}</div>
    <button class="navbtn" data-go="#/week?d=${addDays(ws, 7)}" aria-label="次の週">▶</button>
  </div>`;

  if (S.events.size === 0) {
    h += `<section class="card welcome"><h2>ようこそ</h2>
      <p>右下の「＋ 追加」から、タイトルだけですぐに予定を登録できます。日付や準備はあとから入力できます。</p>
      <p>まず動きを確かめたいときは、確認用サンプル（11月26日 人権・同和教育参観日 など）を読み込んでください。</p>
      <button class="btn primary" data-act="load-sample">確認用サンプルを読み込む</button>
      <details style="margin-top:12px"><summary><b>前に入力したデータが見えないときは</b></summary>
        <p>データは「開いた端末・ブラウザ・開き方」ごとに別々に保存されています。次を確かめてください。</p>
        <ul>
          <li><b>iPhone・iPad</b>：Safariで開いたときと、ホーム画面のアイコンから開いたときは、データが別です。前回と同じ方法で開いてみてください。</li>
          <li>前回と<b>別のブラウザ</b>（Safari／Chrome、LINEの中のブラウザなど）や<b>別の端末</b>で開いていませんか。</li>
          <li><b>プライベートブラウズ（シークレットモード）</b>では、閉じるとデータが消えます。</li>
          <li>アドレスが前回と同じか確かめてください（今のアドレス：${esc(location.origin + location.pathname)}）。</li>
        </ul>
        <p>前のデータが見つかったら、そちらで「設定 → バックアップを保存」し、いつも使う方で「復元」すると、ひとつにまとめられます。</p>
      </details></section>`;
  }

  h += `<div class="summary">
    <div>この週の予定 <b>${weekEvents.length}</b> 件</div>
    <div>この週が期限の準備 <b>${weekPreps.length}</b> 件（未完了 ${weekPreps.filter((p) => !p.done).length}）</div>
    ${od.length ? `<div class="warnnum">期限を過ぎた準備 <b>${od.length}</b> 件</div>` : ''}
  </div>`;

  if (od.length) {
    h += `<section class="card box warn"><h2>期限を過ぎた準備（${od.length}件）</h2>
      <p class="hint">完了にチェックするまで、どの週を開いてもここに表示されます。</p>
      ${od.map((p) => prepRow(p, { showDate: true })).join('')}</section>`;
  }

  h += '<div class="week-grid">';
  for (const d of days) {
    const evs = eventsOn(d);
    const ps = prepsDueOn(d);
    const w = dow(d);
    h += `<section class="day ${d === t ? 'today' : ''} ${w === 6 ? 'sat' : w === 0 ? 'sun' : ''}">
      <header class="day-h"><span class="dname">${fmtMD(d)}</span>${d === t ? '<span class="tag">今日</span>' : ''}
        <button class="addday" data-act="quick-add" data-date="${d}" aria-label="${fmtMD(d)}に予定を追加">＋</button></header>
      ${evs.length ? `<div class="lbl">予定</div>${evs.map((e) => eventRow(e)).join('')}` : ''}
      ${ps.length ? `<div class="lbl">この日が期限の準備</div>${ps.map((p) => prepRow(p)).join('')}` : ''}
      ${!evs.length && !ps.length ? '<p class="empty">予定なし</p>' : ''}
    </section>`;
  }
  h += '</div>';
  return h;
}

/* ---------- 月表示 ---------- */
function viewMonth(q) {
  const t = today();
  const m = q.get('m') || t.slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const nextM = mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
  const prevM = mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`;
  const sel = q.get('d') || (t.startsWith(m) ? t : `${m}-01`);
  const gs = weekStart(`${m}-01`);
  const last = addDays(`${nextM}-01`, -1);
  const ge = addDays(weekStart(last), 6);

  let h = `<div class="viewhead">
    <button class="navbtn" data-go="#/month?m=${prevM}" aria-label="前の月">◀</button>
    <div class="vh-title"><div class="vh-main">${y}年${mo}月</div>
      ${t.startsWith(m) ? '<div class="vh-sub">今月</div>' : '<button class="linkbtn" data-go="#/month">今月へ戻る</button>'}</div>
    <button class="navbtn" data-go="#/month?m=${nextM}" aria-label="次の月">▶</button>
  </div>
  <div class="month-grid">${['月', '火', '水', '木', '金', '土', '日'].map((w, i) => `<div class="mg-h ${i === 5 ? 'sat' : i === 6 ? 'sun' : ''}">${w}</div>`).join('')}`;

  for (let d = gs; d <= ge; d = addDays(d, 1)) {
    const evs = eventsOn(d);
    const ps = prepsDueOn(d);
    const chips = [
      ...evs.map((e) => `<span class="chip ${CAT_CLASS[e.category] || ''} ${KIND_CLASS[e.kind] || ''}">${esc(e.title || '（無題）')}</span>`),
      ...ps.map((p) => `<span class="chip prep ${p.done ? 'done' : ''}"><span class="ck">${p.done ? '☑' : '☐'}</span>${esc(p.title)}</span>`),
    ];
    const max = 3;
    const shown = chips.slice(0, max).join('') + (chips.length > max ? `<span class="chip more">ほか${chips.length - max}件</span>` : '');
    const w = dow(d);
    h += `<button class="cell ${d.slice(0, 7) !== m ? 'out' : ''} ${d === t ? 'today' : ''} ${d === sel ? 'sel' : ''} ${w === 6 ? 'sat' : w === 0 ? 'sun' : ''}" data-replace="#/month?m=${m}&d=${d}" aria-label="${fmtFull(d)} ${chips.length}件">
      <span class="dn">${Number(d.slice(8))}</span>${shown}</button>`;
  }
  h += `</div>
  <div class="legend"><span><span class="chip c-kokugo" style="display:inline">行事・授業</span>（色は分類）</span><span><span class="chip k-shime" style="display:inline">締切</span></span><span><span class="chip prep" style="display:inline">☐準備の期限</span></span></div>`;

  const evs = eventsOn(sel);
  const ps = prepsDueOn(sel);
  h += `<section class="card"><div class="day-h"><span class="dname">${fmtFull(sel)}</span>
      <button class="btn small" data-act="quick-add" data-date="${sel}">＋ この日に追加</button></div>
    ${evs.length ? `<div class="lbl">予定</div>${evs.map((e) => eventRow(e)).join('')}` : ''}
    ${ps.length ? `<div class="lbl">この日が期限の準備</div>${ps.map((p) => prepRow(p)).join('')}` : ''}
    ${!evs.length && !ps.length ? '<p class="empty">この日の予定はありません。</p>' : ''}
    <div class="btnrow"><button class="btn small" data-go="#/week?d=${sel}">この週を週表示で見る</button></div>
  </section>`;
  return h;
}

/* ---------- 日付未定 ---------- */
function viewUndated() {
  const evs = evList().filter((e) => !e.date).sort((a, b) => b.createdAt - a.createdAt);
  const ps = prepList().filter((p) => !p.due && !p.done);
  let h = `<div class="viewhead simple"><div class="vh-title"><h1>日付未定</h1></div></div>
    <p class="hint">日付がまだ決まっていない予定です。日付を入れると、週・月の表示に移ります。</p>`;
  if (!evs.length) h += '<section class="card"><p class="empty">日付未定の予定はありません。</p></section>';
  for (const e of evs) {
    h += `<section class="card" style="padding:10px 12px">${eventRow(e)}
      <div class="row"><span class="flabel" style="margin:0">日付を入れる</span><input type="date" data-act="set-date" data-id="${e.id}" aria-label="「${esc(e.title)}」の日付"></div></section>`;
  }
  if (ps.length) {
    h += `<section class="card"><h2>期限が未定の準備（${ps.length}件）</h2>${ps.map((p) => prepRow(p)).join('')}</section>`;
  }
  return h;
}

/* ---------- 予定の詳細・編集 ---------- */
function viewEvent(id) {
  const ev = S.events.get(id);
  if (!ev) return `<section class="card"><p>この予定は見つかりませんでした（削除された可能性があります）。</p><button class="btn" data-go="#/week">週表示へ</button></section>`;
  return `<div class="detail">
    <div class="detail-top"><button class="navbtn" data-act="back">◀ 戻る</button>
      <span class="muted">${ev.date ? fyLabel(fy(ev.date)) : '日付未定'}${ev.sourceId ? '・前年度から複製' : ''}</span></div>
    <input class="title-input" data-field="title" value="${esc(ev.title)}" placeholder="タイトル" aria-label="タイトル">
    <section class="card">
      <div class="form-row"><label for="f-date">日付</label>
        <div class="row"><input id="f-date" type="date" data-field="date" value="${ev.date || ''}">
        ${ev.date ? '<button class="btn small" data-act="clear-date">日付未定にする</button>' : '<span class="muted">日付未定</span>'}</div></div>
      <div class="form-row two">
        <div><label class="flabel" for="f-st">開始</label><input id="f-st" type="time" data-field="startTime" value="${esc(ev.startTime)}"></div>
        <div><label class="flabel" for="f-et">終了</label><input id="f-et" type="time" data-field="endTime" value="${esc(ev.endTime)}"></div>
      </div>
      <div class="form-row"><label for="f-pl">場所</label><input id="f-pl" data-field="place" value="${esc(ev.place)}" placeholder="例：体育館、2年1組"></div>
      <div class="form-row"><label>分類</label><div class="seg">${['', ...CATS].map((c) => `<button class="${ev.category === c ? 'on' : ''}" data-act="set-seg" data-field="category" data-val="${esc(c)}">${c || '未設定'}</button>`).join('')}</div></div>
      <div class="form-row" style="margin-bottom:0"><label>種類</label><div class="seg">${KINDS.map((k) => `<button class="${ev.kind === k ? 'on' : ''}" data-act="set-seg" data-field="kind" data-val="${k}">${k}</button>`).join('')}</div></div>
    </section>
    <section class="card" id="sec-preps">${prepSection(ev)}</section>
    <section class="card" id="sec-atts">${attSection(ev)}</section>
    <section class="card"><h2>メモ（予定全体）</h2><textarea data-field="memo" rows="5" placeholder="持ち物、連絡事項など">${esc(ev.memo)}</textarea></section>
    ${prevSection(ev)}
    <section class="card"><h2>来年度への申し送り</h2>
      <p class="hint">行事のあとに、来年の自分や担当者へのメモを書いておくと、複製したときに読めます。</p>
      <textarea data-field="handover" rows="4" placeholder="例：資料は1週間前に学年で確認。保護者アンケートは当日回収が良い。">${esc(ev.handover)}</textarea></section>
    <div class="danger-zone"><button class="btn danger" data-act="delete-event">この予定を削除</button></div>
  </div>`;
}

function prepSection(ev) {
  const ps = prepsOf(ev.id);
  const t = today();
  return `<h2>準備（${ps.length}件・未完了${ps.filter((p) => !p.done).length}）</h2>
    <p class="hint">行事より前に済ませる作業です。期限の週の「週表示」に表示されます。</p>
    <ul class="prep-edit">${ps.map((p) => {
      const od = !p.done && p.due && p.due < t;
      return `<li class="${p.done ? 'done' : ''} ${od ? 'overdue' : ''}">
        <input type="checkbox" data-act="toggle-prep" data-id="${p.id}" ${p.done ? 'checked' : ''} aria-label="完了">
        <input class="pt" data-prep-field="title" data-id="${p.id}" value="${esc(p.title)}" aria-label="作業名">
        <button class="iconbtn" data-act="del-prep" data-id="${p.id}" aria-label="削除">削除</button>
        <div class="pdue"><span class="off">期限</span><input type="date" data-prep-field="due" data-id="${p.id}" value="${p.due || ''}" aria-label="期限">
          <span class="off ${od ? 'od' : ''}">${od ? '期限切れ・' : ''}${offsetLabel(p.offset)}</span></div>
      </li>`;
    }).join('')}</ul>
    <div class="prep-add">
      <input id="np-title" placeholder="作業名（例：配付資料の確認）" aria-label="新しい準備の作業名">
      <div class="row"><span class="off">期限</span><input type="date" id="np-due" style="flex:0 1 190px" aria-label="新しい準備の期限">
        <span class="off">または 行事の</span><input type="number" id="np-off" class="num" min="0" inputmode="numeric" aria-label="行事の何日前"><span class="off">日前</span></div>
      <button class="btn primary" data-act="add-prep">準備を追加</button>
    </div>`;
}

function attIcon(a, thumbUrl) {
  if (a.type === 'pdf') return '<span class="att-ico pdf">PDF</span>';
  if (a.type === 'link') return '<span class="att-ico link">リンク</span>';
  return `<span class="att-ico" data-thumb="${a.id}">${thumbUrl ? `<img src="${thumbUrl}" alt="">` : '写真'}</span>`;
}
function attSection(ev) {
  const atts = attsOf(ev.id);
  return `<h2>資料（${atts.length}件）</h2>
    <p class="hint">PDF・写真は元のまま端末内に保存されます。開いて、ページや写真の位置ごとにメモを書けます。</p>
    <ul class="att-list">${atts.map((a) => {
      const n = notesOf(a.id).length;
      return `<li>${attIcon(a)}
        <span class="att-name">${esc(a.name)}<span class="sub">${a.type === 'link' ? esc(a.url) : `${(a.size / 1024 / 1024).toFixed(1)}MB`}${n ? `・メモ${n}件` : ''}</span></span>
        <button class="btn small" data-act="open-att" data-id="${a.id}">開く</button>
        <button class="iconbtn" data-act="del-att" data-id="${a.id}" aria-label="削除">削除</button></li>`;
    }).join('')}</ul>
    <div class="btnrow">
      <label class="btn filebtn">PDF・写真を追加<input type="file" accept="application/pdf,image/*" multiple data-act="add-files"></label>
      <button class="btn" data-act="add-link">Google Driveなどのリンク</button>
    </div>`;
}

const normTitle = (s) => (s || '').replace(/[\s　]/g, '').replace(/[（(].*?[）)]/g, '');
function ancestors(ev) {
  const out = []; let cur = ev; let guard = 0;
  while (cur && cur.sourceId && guard++ < 30) { const s = S.events.get(cur.sourceId); if (!s) break; out.push(s); cur = s; }
  return out;
}
function pastSameTitle(ev) {
  if (!ev.date) return [];
  const t = normTitle(ev.title);
  if (!t) return [];
  return evList().filter((e) => e.id !== ev.id && e.date && fy(e.date) < fy(ev.date) && normTitle(e.title) === t).sort((a, b) => b.date.localeCompare(a.date));
}
function handoverItems(list) {
  return list.map((e) => `<div class="prev-item">
    <div class="muted">${e.date ? `${fyLabel(fy(e.date))}・${fmtFull(e.date)}` : '日付未定'}「${esc(e.title)}」</div>
    <div class="handover-text">${e.handover ? esc(e.handover) : '<span class="muted">（申し送りは書かれていません）</span>'}</div>
    <button class="linkbtn" data-go="#/event/${e.id}">この年の記録を開く</button></div>`).join('');
}
function prevSection(ev) {
  let list = ancestors(ev);
  let note = '';
  if (!list.length) { list = pastSameTitle(ev); note = list.length ? '<p class="hint">同じ名前の過去の行事が見つかりました。</p>' : ''; }
  if (!list.length) return '';
  return `<section class="card prev"><h2>前年度の申し送り</h2>${note}${handoverItems(list.slice(0, 3))}</section>`;
}

/* ---------- 前年度から複製：一覧 ---------- */
let copyKw = '';
function viewCopyList(q) {
  const cur = fy(today());
  const sel = q.get('fy') || String(cur - 1);
  const years = new Set([cur - 1, cur]);
  evList().forEach((e) => e.date && years.add(fy(e.date)));
  const opts = [...years].sort((a, b) => b - a).map((y) => `<option value="${y}" ${String(y) === sel ? 'selected' : ''}>${fyLabel(y)}${y === cur - 1 ? '（前年度）' : y === cur ? '（今年度）' : ''}</option>`).join('');
  return `<div class="viewhead simple"><div class="vh-title"><h1>前年度の行事を複製</h1></div></div>
    <p class="hint">年度は4月〜翌3月です。複製すると行事名・分類・準備リストを引き継ぎ、準備の期限は「行事の何日前か」で計算し直します。</p>
    <div class="filters">
      <select data-act="copy-fy" aria-label="年度">${opts}<option value="all" ${sel === 'all' ? 'selected' : ''}>すべての年度</option></select>
      <input type="search" id="copy-kw" placeholder="行事名・場所・メモで検索" value="${esc(copyKw)}" aria-label="検索">
    </div>
    <div id="copy-list">${copyListHtml(sel)}</div>`;
}
function copyListHtml(sel) {
  const kw = copyKw.trim();
  const list = evList().filter((e) => e.date && (sel === 'all' || fy(e.date) === Number(sel)) &&
    (!kw || [e.title, e.place, e.memo, e.handover].some((s) => (s || '').includes(kw)))).sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) return '<section class="card"><p class="empty">この年度の行事は見つかりませんでした。年度を変えるか、検索語を変えてください。</p></section>';
  const copiedFrom = new Set(evList().map((e) => e.sourceId).filter(Boolean));
  return list.map((e) => `<button class="copy-item" data-go="#/copy/${e.id}">
      <div class="ttl">${esc(e.title)} ${catBadge(e.category)} ${copiedFrom.has(e.id) ? '<span class="badge done-badge">複製済み</span>' : ''}</div>
      <div class="sub">${fmtFull(e.date)}${e.place ? '・' + esc(e.place) : ''}・準備${prepsOf(e.id).length}件・資料${attsOf(e.id).length}件</div>
      ${e.handover ? `<div class="ho">申し送り：${esc(e.handover)}</div>` : ''}
    </button>`).join('');
}

/* ---------- 前年度から複製：確認・修正 ---------- */
let CF = null;
function initCF(src) {
  const cur = fy(today());
  const targetFy = Math.max(cur, fy(src.date) + 1);
  let [, mm, dd] = src.date.split('-').map(Number);
  const yy = mm >= 4 ? targetFy : targetFy + 1;
  if (!isValidDate(yy, mm, dd)) dd = 28;
  const date = `${yy}-${pad(mm)}-${pad(dd)}`;
  CF = {
    srcId: src.id, date, title: src.title, place: src.place, startTime: src.startTime, endTime: src.endTime,
    category: src.category, kind: src.kind, memo: false,
    preps: prepsOf(src.id).map((p) => {
      const offset = p.offset ?? (p.due ? diffDays(src.date, p.due) : null);
      return { title: p.title, offset, due: offset != null ? addDays(date, -offset) : null, include: true, srcDue: p.due };
    }),
    atts: Object.fromEntries(attsOf(src.id).map((a) => [a.id, true])),
  };
}
function viewCopyForm(id) {
  const src = S.events.get(id);
  if (!src || !src.date) return '<section class="card"><p>複製元が見つかりません。</p><button class="btn" data-go="#/copy">一覧へ</button></section>';
  if (!CF || CF.srcId !== id) initCF(src);
  const atts = attsOf(src.id);
  return `<div class="viewhead simple"><button class="navbtn" data-go="#/copy">◀ 一覧</button><div class="vh-title"><h1>複製して今年度に登録</h1></div></div>
    <section class="card"><div class="muted">複製元（${fyLabel(fy(src.date))}）</div>
      <div style="font-weight:700;font-size:1.15rem">${esc(src.title)} ${catBadge(src.category)}</div>
      <div>${fmtFull(src.date)}${src.place ? '・' + esc(src.place) : ''}</div>
      <button class="linkbtn" data-go="#/event/${src.id}">複製元の記録を開く（前年度の記録はそのまま残ります）</button></section>
    <section class="card prev"><h2>前年度の申し送り</h2>
      <div class="handover-text">${src.handover ? esc(src.handover) : '<span class="muted">（申し送りは書かれていません）</span>'}</div>
      ${src.memo ? `<details><summary>前年度のメモを見る</summary><div class="handover-text">${esc(src.memo)}</div></details>` : ''}</section>
    <section class="card"><h2>今年度の内容</h2>
      <div class="form-row"><label for="cf-date">今年度の開催日</label><input id="cf-date" type="date" data-cf="date" value="${CF.date || ''}"></div>
      <div class="form-row"><label for="cf-title">行事名</label><input id="cf-title" data-cf="title" value="${esc(CF.title)}"></div>
      <div class="form-row two"><div><label class="flabel">開始</label><input type="time" data-cf="startTime" value="${esc(CF.startTime)}"></div>
        <div><label class="flabel">終了</label><input type="time" data-cf="endTime" value="${esc(CF.endTime)}"></div></div>
      <div class="form-row"><label>場所</label><input data-cf="place" value="${esc(CF.place)}"></div>
      <div class="form-row" style="margin-bottom:0"><label>分類</label><div class="seg">${['', ...CATS].map((c) => `<button class="${CF.category === c ? 'on' : ''}" data-act="cf-seg" data-val="${esc(c)}">${c || '未設定'}</button>`).join('')}</div></div>
    </section>
    <section class="card" id="cf-preps">${cfPrepsHtml()}</section>
    ${atts.length ? `<section class="card"><h2>引き継ぐ資料</h2><p class="hint">必要なものだけ選んでください。資料ごとのメモも一緒に引き継ぎます。</p>
      ${atts.map((a) => `<label class="check-row"><input type="checkbox" data-cf-att="${a.id}" ${CF.atts[a.id] ? 'checked' : ''}>${attIcon(a)}<span class="att-name">${esc(a.name)}${notesOf(a.id).length ? `<span class="sub">メモ${notesOf(a.id).length}件</span>` : ''}</span></label>`).join('')}</section>` : ''}
    ${src.memo ? `<section class="card"><label class="check-row"><input type="checkbox" data-cf="memo" ${CF.memo ? 'checked' : ''}>前年度の「メモ（予定全体）」も引き継ぐ</label></section>` : ''}
    <div class="sticky-actions"><button class="btn primary big" data-act="cf-save">この内容で今年度に登録</button></div>`;
}
function cfPrepsHtml() {
  return `<h2>準備リスト（期限を確認・修正）</h2>
    <p class="hint">期限は「行事の何日前か」をもとに、新しい開催日から計算しています。完了チェックはすべて未完了に戻ります。</p>
    ${CF.preps.map((p, i) => `<div class="cf-prep ${p.include ? '' : 'off'}">
      <label class="chk"><input type="checkbox" data-cfp="include" data-i="${i}" ${p.include ? 'checked' : ''} aria-label="この準備を引き継ぐ"></label>
      <div class="cf-prep-main">
        <input data-cfp="title" data-i="${i}" value="${esc(p.title)}" aria-label="作業名">
        <div class="row"><span class="off">行事の</span><input type="number" class="num" data-cfp="offset" data-i="${i}" value="${p.offset ?? ''}" inputmode="numeric" aria-label="何日前"><span class="off">日前 → 期限</span>
          <input type="date" data-cfp="due" data-i="${i}" value="${p.due || ''}" aria-label="期限"></div>
        ${p.srcDue ? `<div class="off">前年度の期限：${fmtMD(p.srcDue)}</div>` : ''}
      </div></div>`).join('')}
    <div class="btnrow"><button class="btn small" data-act="cf-add-prep">＋ 準備を追加</button></div>`;
}

/* ---------- 一括登録（試験版） ---------- */
let BULK = [];
function viewBulk() {
  const cur = fy(today());
  return `<div class="viewhead simple"><button class="navbtn" data-go="#/settings">◀</button><div class="vh-title"><h1>月間行事予定から一括登録（試験版）</h1></div></div>
    <section class="card">
      <p>月間行事予定の文字を貼り付けると、<b>日付・行事名・場所</b>の候補を作ります。確認・修正してからまとめて登録できます。</p>
      <div class="note-box">写真やPDFの場合：iPhone・iPadの写真アプリの「テキスト認識表示」や、Googleレンズなどで文字を選んでコピーし、ここに貼り付けてください（追加料金なし）。写真・PDFからの自動読み取りは今後の拡張予定です。</div>
      <div class="form-row" style="margin-top:12px"><label>年度（月だけの日付は、この年度として読み取ります）</label>
        <select id="bulk-fy">${[cur - 1, cur, cur + 1].map((y) => `<option value="${y}" ${y === cur ? 'selected' : ''}>${fyLabel(y)}</option>`).join('')}</select></div>
      <div class="form-row"><label>貼り付け欄（1行に1件）</label>
        <textarea id="bulk-text" rows="8" placeholder="11/26(木) 人権・同和教育参観日 体育館&#10;12月3日 13:30 国語研究授業（2年1組）&#10;12月&#10;10(木) 学年集会"></textarea></div>
      <button class="btn primary" data-act="bulk-parse">候補を作る</button>
    </section>
    <div id="bulk-cands">${bulkCandsHtml()}</div>`;
}
function parseBulk(text, fyYear) {
  const out = [];
  let curMonth = null;
  const z2h = (s) => s.replace(/[０-９／：－（）]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
  for (let line of text.split(/\r?\n/)) {
    line = z2h(line).trim();
    if (!line) continue;
    let mo, d, y = null, rest;
    let m = line.match(/^(?:(\d{4})\s*[\/年.\-]\s*)?(\d{1,2})\s*[\/月.\-]\s*(\d{1,2})\s*日?\s*(?:[(（]\s*[月火水木金土日祝・]+\s*[)）])?\s*(.*)$/);
    const mh = line.match(/^(\d{1,2})\s*月\s*(?:行事予定.*)?$/);
    if (mh) { curMonth = Number(mh[1]); continue; }
    if (m) { y = m[1] ? Number(m[1]) : null; mo = Number(m[2]); d = Number(m[3]); rest = m[4]; }
    else if (curMonth && (m = line.match(/^(\d{1,2})\s*日?\s*(?:[(（]\s*[月火水木金土日祝]\s*[)）]|\s+[月火水木金土日](?=\s))\s*(.*)$/))) { mo = curMonth; d = Number(m[1]); rest = m[2]; }
    else { out.push({ include: false, date: '', title: line, place: '', startTime: '', category: '' }); continue; }
    if (!y) y = mo >= 4 ? fyYear : fyYear + 1;
    const date = isValidDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : '';
    rest = rest.trim();
    let startTime = '';
    const tm = rest.match(/^(\d{1,2}):(\d{2})(?:\s*[〜~\-]\s*\d{1,2}:\d{2})?\s*/);
    if (tm) { startTime = `${pad(tm[1])}:${tm[2]}`; rest = rest.slice(tm[0].length); }
    let place = '';
    const pm = rest.match(/\s*[(（【@＠]\s*([^)）】]+?)\s*[)）】]?\s*$/);
    if (pm && pm.index > 0) { place = pm[1]; rest = rest.slice(0, pm.index); }
    else { const toks = rest.split(/\s+/); if (toks.length >= 2) { place = toks.pop(); rest = toks.join(' '); } }
    if (!rest) continue;
    out.push({ include: !!date, date, title: rest.trim(), place, startTime, category: '' });
  }
  return out;
}
function bulkCandsHtml() {
  if (!BULK.length) return '';
  return `<section class="card"><h2>読み取った候補（${BULK.length}件）</h2>
    <p class="hint">チェックした項目だけ登録します。日付が空のものは「日付未定」に入ります。</p>
    ${BULK.map((c, i) => `<div class="cand"><input type="checkbox" data-bulk="include" data-i="${i}" ${c.include ? 'checked' : ''} aria-label="登録する">
      <div class="cand-fields">
        <input class="wide" data-bulk="title" data-i="${i}" value="${esc(c.title)}" aria-label="行事名">
        <input type="date" data-bulk="date" data-i="${i}" value="${c.date}" aria-label="日付">
        <input data-bulk="place" data-i="${i}" value="${esc(c.place)}" placeholder="場所" aria-label="場所">
        <select class="wide" data-bulk="category" data-i="${i}" aria-label="分類"><option value="">分類：未設定</option>${CATS.map((k) => `<option ${c.category === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
      </div></div>`).join('')}
    <div class="btnrow"><button class="btn primary big" data-act="bulk-save">チェックした項目を登録</button></div></section>`;
}

/* ---------- 設定・データ ---------- */
function viewSettings() {
  const lb = getMeta('lastBackup');
  return `<div class="viewhead simple"><div class="vh-title"><h1>設定・データ</h1></div></div>
    <section class="card"><h2>保存先と同期</h2><div id="storage-info">確認中…</div></section>
    <section class="card"><h2>バックアップと復元</h2>
      <p class="hint">予定・準備・メモ・添付資料（PDF・写真の本体を含む）を1つのファイルに保存します。機種変更や、別の端末にデータを移すときにも使います。</p>
      <div class="btnrow"><button class="btn primary" data-act="backup">バックアップを保存</button>
        <label class="btn filebtn">バックアップから復元<input type="file" accept=".json,application/json" data-act="restore"></label></div>
      <p class="${lb && diffDays(today(), lb.slice(0, 10)) <= 30 ? 'muted' : 'ng'}" style="margin-bottom:0">最終バックアップ：${lb ? new Date(lb).toLocaleString('ja-JP') : 'まだありません'}</p>
    </section>
    <section class="card"><h2>まとめて登録</h2>
      <p class="hint">月間行事予定の文字を貼り付けて、日付・行事名・場所の候補を一括登録します。</p>
      <button class="btn" data-go="#/bulk">月間行事予定から一括登録（試験版）</button></section>
    <section class="card"><h2>確認用サンプル</h2>
      <p class="hint">「11月26日 人権・同和教育参観日」と準備2件、前年度の行事などを追加します。</p>
      <button class="btn" data-act="load-sample">確認用サンプルを読み込む</button></section>
    <section class="card"><h2>すべてのデータを削除</h2>
      <p class="hint">この端末に保存したすべての予定・資料を消します。先にバックアップを保存してください。</p>
      <button class="btn danger" data-act="wipe">すべて削除</button></section>
    <p class="muted" style="text-align:center">先生の予定ノート ${APP_VERSION}</p>`;
}
async function fillStorageInfo() {
  const el = $('#storage-info');
  if (!el) return;
  let persisted = null; let est = null;
  try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { /* 非対応 */ }
  try { est = navigator.storage?.estimate ? await navigator.storage.estimate() : null; } catch { /* 非対応 */ }
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  el.innerHTML = `<dl class="info">
      <dt>保存先</dt><dd><b>この端末のこのブラウザの中</b>（IndexedDB）。インターネット上のサーバーには送信していません。</dd>
      <dt>このデータの場所</dt><dd>${esc(location.origin + location.pathname)} を<b>${standalone ? 'ホーム画面のアイコンから' : 'ブラウザで'}</b>開いたときのデータです。別のアドレス・別のブラウザ・別の開き方では、別のデータになります。</dd>
      <dt>端末間の同期</dt><dd><span class="ng">同期なし</span>　スマホ・iPad・パソコンのデータはそれぞれ別です。別の端末へ移すときは「バックアップを保存」→ 移す先で「バックアップから復元」をしてください。</dd>
      <dt>消えにくくする設定</dt><dd>${persisted === true ? '<span class="ok">許可済み</span>（ブラウザが自動で消さない設定）' : persisted === false ? '<span class="ng">未許可</span> <button class="btn small" data-act="persist">許可を求める</button>' : 'このブラウザでは確認できません'}</dd>
      <dt>使用量</dt><dd>${est ? `${mb(est.usage || 0)}（上限の目安 ${mb(est.quota || 0)}）` : '確認できません'}</dd>
      <dt>登録件数</dt><dd>予定 ${S.events.size}・準備 ${S.preps.size}・資料 ${S.attachments.size}・資料メモ ${S.notes.size}</dd>
      <dt>アプリとして起動</dt><dd>${standalone ? '<span class="ok">ホーム画面から起動中</span>' : 'ブラウザで表示中'}</dd>
    </dl>
    ${ios ? `<div class="note-box"><b>iPhone・iPadの注意：</b>Safariで開いたときと、ホーム画面のアイコンから開いたときでは、データが別々に保存されます。<b>いつも同じ方法（おすすめはホーム画面のアイコン）</b>で開いてください。${standalone ? '' : '<br>Safariで7日以上開かないと、サイトのデータが消されることがあります。'}</div>` : ''}
    <div class="note-box">プライベートブラウズ（シークレットモード）で開くと、閉じたときにデータが消えます。</div>
    <div class="note-box">ブラウザの「履歴とWebサイトデータを消去」を行うと、このアプリのデータも消えます。定期的にバックアップを保存してください。</div>`;
}

/* ---------- 画面の切り替え ---------- */
let currentView = null; let currentEventId = null; let lastListHash = '#/week';
function render() {
  const raw = location.hash.replace(/^#\/?/, '') || 'week';
  const [path, qs] = raw.split('?');
  const parts = path.split('/');
  const q = new URLSearchParams(qs || '');
  const view = parts[0];
  currentEventId = null;
  let html;
  switch (view) {
    case 'month': html = viewMonth(q); break;
    case 'undated': html = viewUndated(); break;
    case 'event': currentEventId = parts[1]; html = viewEvent(parts[1]); break;
    case 'copy': html = parts[1] ? viewCopyForm(parts[1]) : viewCopyList(q); break;
    case 'settings': html = viewSettings(); break;
    case 'bulk': html = viewBulk(); break;
    default: html = viewWeek(q);
  }
  if (view !== 'event' && !(view === 'copy' && parts[1])) lastListHash = location.hash || '#/week';
  if (!(view === 'copy' && parts[1])) CF = null;
  $('#view').innerHTML = html;
  const tab = view === 'bulk' ? 'settings' : view === 'event' ? null : (['week', 'month', 'undated', 'copy', 'settings'].includes(view) ? view : 'week');
  $$('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  const n = evList().filter((e) => !e.date).length;
  const badge = $('#undated-badge'); badge.hidden = !n; badge.textContent = n;
  const key = view + (parts[1] || '');
  if (key !== currentView) { window.scrollTo(0, 0); currentView = key; }
  if (view === 'settings') fillStorageInfo();
  if (view === 'event') loadThumbs();
}
function rerender() { const y = window.scrollY; render(); window.scrollTo(0, y); }

async function loadThumbs() {
  for (const el of $$('[data-thumb]')) {
    const a = S.attachments.get(el.dataset.thumb);
    if (!a || !a.blobId) continue;
    const rec = await DB.get('blobs', a.blobId);
    if (rec && el.isConnected) {
      const url = URL.createObjectURL(new Blob([rec.data], { type: rec.mime }));
      el.innerHTML = `<img src="${url}" alt="">`;
    }
  }
}

/* ---------- シート・トースト ---------- */
let sheetOnClose = null;
function openSheet(html, onClose) {
  $('#sheet').innerHTML = html;
  $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false;
  sheetOnClose = onClose || null;
  const f = $('#sheet [autofocus]'); if (f) setTimeout(() => f.focus(), 50);
}
function closeSheet(runCb = true) {
  $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; $('#sheet').innerHTML = '';
  const cb = sheetOnClose; sheetOnClose = null;
  if (runCb && cb) cb();
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2000);
}

/* ---------- すぐに追加 ---------- */
let qaCat = '';
function openQuickAdd(date) {
  qaCat = '';
  openSheet(`<h2>予定を追加</h2>
    <label for="qa-title">タイトル（これだけでも登録できます）</label>
    <input id="qa-title" autofocus placeholder="例：人権・同和教育参観日" enterkeyhint="done">
    <label for="qa-date">日付（あとからでも入力できます）</label>
    <input id="qa-date" type="date" value="${date || ''}">
    <label>分類（任意）</label>
    <div class="seg" id="qa-cats">${CATS.map((c) => `<button data-act="qa-cat" data-val="${c}">${c}</button>`).join('')}</div>
    <div class="sheet-actions">
      <button class="btn primary big" data-act="qa-save">登録する</button>
      <button class="btn" data-act="qa-save" data-detail="1">登録して詳細を入力</button>
      <button class="btn ghost" data-act="close-sheet">やめる</button>
    </div>`);
}
async function quickSave(detail) {
  const title = $('#qa-title').value.trim();
  if (!title) { toast('タイトルを入力してください'); $('#qa-title').focus(); return; }
  const ev = newEvent({ title, date: $('#qa-date').value || null, category: qaCat });
  await save('events', ev);
  closeSheet(false);
  toast(ev.date ? `${fmtMD(ev.date)}に登録しました` : '日付未定で登録しました');
  if (detail) location.hash = `#/event/${ev.id}`; else rerender();
}

/* ---------- 予定の編集 ---------- */
const fieldTimers = new Map();
function scheduleFieldSave(el) {
  const k = el.dataset.field;
  const evId = currentEventId;
  const t = fieldTimers.get(k); if (t) clearTimeout(t.timer);
  fieldTimers.set(k, { el, evId, timer: setTimeout(() => { fieldTimers.delete(k); onFieldChange(el, true, evId); }, 500) });
}
// 予約中の保存と、入力途中の「準備」をすぐに保存する
async function flushPending() {
  const jobs = [...fieldTimers.values()];
  fieldTimers.clear();
  for (const j of jobs) { clearTimeout(j.timer); await onFieldChange(j.el, true, j.evId); }
  const np = $('#np-title');
  if (np && np.value.trim() && currentEventId) await addPrep(true);
}
async function onFieldChange(el, quiet, evId) {
  const ev = S.events.get(evId || currentEventId);
  if (!ev) return;
  const f = el.dataset.field;
  let v = el.value;
  if (f === 'date') return changeEventDate(ev, v || null);
  if (f === 'title') {
    v = v.trim();
    if (!v) { if (!quiet) { el.value = ev.title; toast('タイトルは空にできません'); } return; }
  }
  if (ev[f] === v) return;
  ev[f] = v;
  await save('events', ev);
  if (!quiet) toast('保存しました');
}

let pendingShift = null;
async function changeEventDate(ev, newDate) {
  const old = ev.date;
  if (old === newDate) return;
  const ps = prepsOf(ev.id).filter((p) => p.due);
  if (old && newDate && ps.length) {
    const delta = diffDays(newDate, old);
    pendingShift = { evId: ev.id, newDate, delta };
    openSheet(`<h2>準備の期限をどうしますか？</h2>
      <p>行事の日付を <b>${fmtMD(old)}</b> から <b>${fmtMD(newDate)}</b> に変えます（${delta > 0 ? `${delta}日後ろ` : `${-delta}日前`}へ移動）。</p>
      <table class="shift"><tr><th>準備</th><th>今の期限</th><th>ずらした場合</th></tr>
        ${ps.map((p) => `<tr><td>${esc(p.title)}</td><td>${fmtMD(p.due)}</td><td class="new">${fmtMD(addDays(p.due, delta))}</td></tr>`).join('')}</table>
      <div class="sheet-actions">
        <button class="btn primary big" data-act="shift-apply" data-mode="shift">期限も${Math.abs(delta)}日ずらす</button>
        <button class="btn" data-act="shift-apply" data-mode="keep">期限はそのままにする</button>
        <button class="btn ghost" data-act="shift-apply" data-mode="cancel">日付の変更をやめる</button>
      </div>`, () => { pendingShift = null; rerender(); });
    return;
  }
  ev.date = newDate;
  await save('events', ev);
  await recalcOffsets(ev);
  toast(newDate ? `${fmtMD(newDate)}に変更しました` : '日付未定にしました');
  rerender();
}
async function applyShift(mode) {
  const ps = pendingShift; pendingShift = null;
  if (!ps || mode === 'cancel') { closeSheet(true); return; }
  const ev = S.events.get(ps.evId);
  ev.date = ps.newDate;
  await save('events', ev);
  if (mode === 'shift') {
    for (const p of prepsOf(ev.id)) if (p.due) { p.due = addDays(p.due, ps.delta); await save('preps', p); }
  }
  await recalcOffsets(ev);
  closeSheet(false);
  toast(mode === 'shift' ? '行事の日付と準備の期限を変更しました' : '行事の日付を変更しました（期限はそのまま）');
  rerender();
}

function refreshPrepSection() {
  const ev = S.events.get(currentEventId);
  const sec = $('#sec-preps');
  if (ev && sec) sec.innerHTML = prepSection(ev);
}
function refreshAttSection() {
  const ev = S.events.get(currentEventId);
  const sec = $('#sec-atts');
  if (ev && sec) { sec.innerHTML = attSection(ev); loadThumbs(); }
}

async function addPrep(silent) {
  const ev = S.events.get(currentEventId);
  if (!ev || !$('#np-title')) return;
  const title = $('#np-title').value.trim();
  if (!title) { if (!silent) { toast('作業名を入力してください'); $('#np-title').focus(); } return; }
  let due = $('#np-due').value || null;
  const offRaw = $('#np-off').value;
  let offset = offRaw !== '' ? Number(offRaw) : null;
  if (!due && offset != null && ev.date) due = addDays(ev.date, -offset);
  if (due && ev.date) offset = diffDays(ev.date, due);
  $('#np-title').value = '';
  await save('preps', newPrep({ eventId: ev.id, title, due, offset: due || offset != null ? offset : null }));
  if (silent) { toast(`入力途中の準備「${title}」も保存しました`); return; }
  refreshPrepSection();
  toast(due ? `準備を追加しました（期限 ${fmtMD(due)}）` : '準備を追加しました（期限未定）');
  $('#np-title').focus();
}

async function deleteAttachment(att) {
  for (const n of notesOf(att.id)) await removeRec('notes', n.id);
  await removeRec('attachments', att.id);
  if (att.blobId && ![...S.attachments.values()].some((a) => a.blobId === att.blobId)) await DB.del('blobs', att.blobId);
}

async function addFiles(input) {
  const ev = S.events.get(currentEventId);
  const files = [...input.files];
  input.value = '';
  let ok = 0;
  for (const file of files) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImg = file.type.startsWith('image/');
    if (!isPdf && !isImg) { toast(`${file.name} はPDF・写真ではありません`); continue; }
    try {
      const buf = await file.arrayBuffer();
      const blobId = uid();
      await DB.put('blobs', { id: blobId, mime: file.type || (isPdf ? 'application/pdf' : 'image/jpeg'), data: buf });
      await save('attachments', { id: uid(), eventId: ev.id, type: isPdf ? 'pdf' : 'image', name: file.name || (isPdf ? '資料.pdf' : '写真'), mime: file.type, size: file.size, blobId, createdAt: Date.now() });
      ok++;
    } catch (e) { console.error(e); toast('保存できませんでした（容量不足の可能性）'); }
  }
  refreshAttSection();
  if (ok) toast(`${ok}件の資料を追加しました`);
}

function openLinkSheet() {
  openSheet(`<h2>リンクを追加</h2>
    <label for="lk-url">URL（Google Driveの共有リンクなど）</label><input id="lk-url" type="url" autofocus placeholder="https://drive.google.com/...">
    <label for="lk-name">表示名</label><input id="lk-name" placeholder="例：参観日 指導案">
    <div class="sheet-actions"><button class="btn primary big" data-act="save-link">追加する</button><button class="btn ghost" data-act="close-sheet">やめる</button></div>`);
}
async function saveLink() {
  const url = $('#lk-url').value.trim();
  if (!/^https?:\/\//i.test(url)) { toast('https:// から始まるURLを入力してください'); return; }
  let name = $('#lk-name').value.trim();
  if (!name) name = /drive\.google|docs\.google/.test(url) ? 'Google Driveの資料' : url;
  await save('attachments', { id: uid(), eventId: currentEventId, type: 'link', name, url, size: 0, createdAt: Date.now() });
  closeSheet(false); refreshAttSection(); toast('リンクを追加しました');
}

async function deleteEvent(ev) {
  if (!confirm(`「${ev.title}」を削除します。準備・メモ・添付資料も消えます。よろしいですか？`)) return;
  for (const p of prepsOf(ev.id)) await removeRec('preps', p.id);
  for (const a of attsOf(ev.id)) await deleteAttachment(a);
  await removeRec('events', ev.id);
  toast('削除しました');
  location.hash = lastListHash || '#/week';
}

/* ---------- 資料ビューア（PDF・写真＋メモ） ---------- */
let V = null; let pdfjsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PDFJS_BASE + 'pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js'; res(window.pdfjsLib); };
      s.onerror = () => { pdfjsPromise = null; s.remove(); rej(new Error('pdf.js load failed')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsPromise;
}
async function openViewer(att) {
  const rec = await DB.get('blobs', att.blobId);
  if (!rec) { toast('資料のデータが見つかりません'); return; }
  V = { att, data: rec.data, url: URL.createObjectURL(new Blob([rec.data], { type: rec.mime || att.mime })), page: 1, pages: 0, pin: null, pdf: null, pdfFailed: false };
  $('#viewer').hidden = false;
  document.body.classList.add('noscroll');
  $('#viewer').innerHTML = `<div class="vw-head"><button class="btn small" data-act="close-viewer">✕ 閉じる</button>
      <div class="vw-title">${esc(att.name)}</div>
      <a class="btn small" href="${V.url}" target="_blank" rel="noopener">別タブで開く</a></div>
    <div class="vw-body"><div class="vw-doc" id="vw-doc"></div><div class="vw-notes" id="vw-notes"></div></div>`;
  renderDoc(); renderNotes();
  if (att.type === 'pdf') renderPdf();
}
function closeViewer() {
  if (!V) return;
  try { V.renderTask?.cancel(); V.pdf?.destroy(); } catch { /* 無視 */ }
  URL.revokeObjectURL(V.url);
  V = null;
  $('#viewer').hidden = true; $('#viewer').innerHTML = '';
  document.body.classList.remove('noscroll');
  refreshAttSection();
}
function renderDoc() {
  const doc = $('#vw-doc');
  if (V.att.type === 'image') {
    const pins = notesOf(V.att.id).filter((n) => n.x != null).map((n, i) => `<span class="pin" style="left:${n.x}%;top:${n.y}%">${i + 1}</span>`).join('');
    doc.innerHTML = `<p class="hint" style="margin:4px 4px 8px">写真をタップすると、その位置にメモをつけられます。元の写真は変更されません。</p>
      <div class="pinwrap" data-act="pin-image"><img src="${V.url}" alt="${esc(V.att.name)}">${pins}${V.pin ? `<span class="pin pending" style="left:${V.pin.x}%;top:${V.pin.y}%">＋</span>` : ''}</div>`;
  } else {
    doc.innerHTML = `<div class="pdfnav"><button class="navbtn" data-act="pdf-page" data-d="-1" aria-label="前のページ">◀</button>
        <span id="pdf-pg">${V.page} / ${V.pages || '?'} ページ</span>
        <button class="navbtn" data-act="pdf-page" data-d="1" aria-label="次のページ">▶</button></div>
      <div class="pdfwrap"><canvas id="pdfc"></canvas><div class="pdfmsg" id="pdfmsg">読み込み中…</div></div>`;
  }
}
async function renderPdf() {
  const msg = $('#pdfmsg');
  try {
    const lib = await loadPdfJs();
    if (!V) return;
    if (!V.pdf) { V.pdf = await lib.getDocument({ data: new Uint8Array(V.data.slice(0)) }).promise; V.pages = V.pdf.numPages; }
    const page = await V.pdf.getPage(V.page);
    if (!V) return;
    const wrap = $('.pdfwrap');
    const w = Math.max(200, wrap.clientWidth);
    const scale = w / page.getViewport({ scale: 1 }).width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: scale * dpr });
    const c = $('#pdfc');
    c.width = vp.width; c.height = vp.height;
    c.style.width = `${w}px`; c.style.height = `${vp.height / dpr}px`;
    try { V.renderTask?.cancel(); } catch { /* 無視 */ }
    V.renderTask = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    await V.renderTask.promise;
    msg.textContent = '';
    $('#pdf-pg').textContent = `${V.page} / ${V.pages} ページ`;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    console.warn(e);
    if (!V) return;
    V.pdfFailed = true;
    msg.innerHTML = 'PDFを画面内に表示できませんでした（オフラインなど）。右上の「別タブで開く」で見られます。<br>ページ送りボタンでページ番号を選んで、メモを書けます。';
    $('#pdf-pg').textContent = `${V.page} ページ`;
  }
}
function renderNotes() {
  const el = $('#vw-notes');
  const all = notesOf(V.att.id);
  let h;
  if (V.att.type === 'pdf') {
    const here = all.filter((n) => (n.page || 1) === V.page);
    const others = all.filter((n) => (n.page || 1) !== V.page);
    h = `<h3>${V.page}ページのメモ</h3>
      <textarea id="note-text" rows="3" placeholder="このページについてのメモ"></textarea>
      <div class="btnrow"><button class="btn primary" data-act="add-note">メモを追加</button></div>
      <ul class="note-list">${here.map((n) => noteLi(n, null)).join('') || '<li class="muted">このページのメモはまだありません。</li>'}</ul>
      ${others.length ? `<h3 style="margin-top:14px">ほかのページのメモ</h3><ul class="note-list">${others.map((n) => `<li><button class="btn small" data-act="pdf-goto" data-p="${n.page || 1}">${n.page || 1}p</button><span class="note-text">${esc(n.text)}</span></li>`).join('')}</ul>` : ''}`;
  } else {
    let k = 0;
    h = `<h3>写真のメモ</h3>
      <p class="hint">${V.pin ? '<b>選んだ位置</b>にメモをつけます。' : '写真をタップして位置を選ぶか、位置なしでメモを書けます。'}${V.pin ? ' <button class="linkbtn" data-act="unpin">位置を解除</button>' : ''}</p>
      <textarea id="note-text" rows="3" placeholder="写真についてのメモ"></textarea>
      <div class="btnrow"><button class="btn primary" data-act="add-note">メモを追加</button></div>
      <ul class="note-list">${all.map((n) => noteLi(n, n.x != null ? ++k : null)).join('') || '<li class="muted">メモはまだありません。</li>'}</ul>`;
  }
  el.innerHTML = h;
}
function noteLi(n, no) {
  return `<li><span class="note-no ${no ? '' : 'plain'}">${no || '・'}</span><span class="note-text">${esc(n.text)}</span>
    <button class="iconbtn" data-act="edit-note" data-id="${n.id}">編集</button></li>`;
}
async function addNote() {
  const text = $('#note-text').value.trim();
  if (!text) { toast('メモを入力してください'); return; }
  const n = { id: uid(), attachmentId: V.att.id, eventId: V.att.eventId, text, createdAt: Date.now() };
  if (V.att.type === 'pdf') n.page = V.page;
  if (V.att.type === 'image' && V.pin) { n.x = V.pin.x; n.y = V.pin.y; }
  await save('notes', n);
  V.pin = null;
  if (V.att.type === 'image') renderDoc();
  renderNotes();
  toast('メモを保存しました');
}
function editNote(id) {
  const n = S.notes.get(id);
  openSheet(`<h2>メモを編集</h2><textarea id="en-text" rows="5" autofocus>${esc(n.text)}</textarea>
    <div class="sheet-actions"><button class="btn primary big" data-act="note-save" data-id="${id}">保存</button>
    <button class="btn danger" data-act="note-del" data-id="${id}">このメモを削除</button>
    <button class="btn ghost" data-act="close-sheet">やめる</button></div>`);
}

/* ---------- 複製の保存 ---------- */
async function saveCopy() {
  const src = S.events.get(CF.srcId);
  if (!CF.title.trim()) { toast('行事名を入力してください'); return; }
  if (!CF.date) { toast('今年度の開催日を入れてください'); $('#cf-date').focus(); return; }
  const ev = newEvent({
    title: CF.title.trim(), date: CF.date, startTime: CF.startTime, endTime: CF.endTime, place: CF.place,
    category: CF.category, kind: CF.kind, memo: CF.memo ? src.memo : '', sourceId: src.id,
  });
  await save('events', ev);
  for (const p of CF.preps.filter((x) => x.include && x.title.trim())) {
    await save('preps', newPrep({ eventId: ev.id, title: p.title.trim(), due: p.due, offset: p.due ? diffDays(ev.date, p.due) : p.offset, done: false }));
  }
  for (const a of attsOf(src.id).filter((x) => CF.atts[x.id])) {
    const na = { ...a, id: uid(), eventId: ev.id, createdAt: Date.now() }; // 資料本体は共有（元の資料はそのまま）
    await save('attachments', na);
    for (const n of notesOf(a.id)) await save('notes', { ...n, id: uid(), attachmentId: na.id, eventId: ev.id });
  }
  CF = null;
  toast('今年度の行事として登録しました');
  location.hash = `#/event/${ev.id}`;
}

/* ---------- バックアップ ---------- */
function abToB64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToAb(b64) {
  const s = atob(b64); const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}
async function exportBackup() {
  toast('バックアップを作成中…');
  const blobs = await DB.all('blobs');
  const data = {
    app: 'sensei-note', format: 1, version: APP_VERSION, exportedAt: new Date().toISOString(),
    events: evList(), preps: prepList(), attachments: [...S.attachments.values()], notes: [...S.notes.values()],
    meta: [...S.meta.values()].filter((m) => m.id !== 'lastBackup'),
    blobs: blobs.map((b) => ({ id: b.id, mime: b.mime, data: abToB64(b.data) })),
  };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `sensei-note-backup-${today()}.json`);
  await setMeta('lastBackup', new Date().toISOString());
  toast('バックアップファイルを保存しました');
  if (location.hash.startsWith('#/settings')) rerender();
}
async function restoreBackup(input) {
  const file = input.files[0]; input.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { alert('ファイルを読み込めませんでした。'); return; }
  if (data.app !== 'sensei-note' || !Array.isArray(data.events)) { alert('「先生の予定ノート」のバックアップファイルではありません。'); return; }
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString('ja-JP') : '日時不明';
  if (!confirm(`${when} のバックアップ（予定${data.events.length}件・資料${(data.attachments || []).length}件）で、今のデータをすべて置き換えます。よろしいですか？`)) return;
  try {
    for (const s of STORES) await DB.clear(s);
    await DB.putMany('events', data.events);
    await DB.putMany('preps', data.preps || []);
    await DB.putMany('attachments', data.attachments || []);
    await DB.putMany('notes', data.notes || []);
    await DB.putMany('meta', data.meta || []);
    for (const b of data.blobs || []) await DB.put('blobs', { id: b.id, mime: b.mime, data: b64ToAb(b.data) });
    await loadAll();
    toast('復元しました');
    location.hash = '#/week'; rerender();
  } catch (e) { console.error(e); alert('復元中にエラーが起きました（容量不足の可能性）。'); }
}

/* ---------- 確認用サンプル ---------- */
async function loadSample() {
  if (getMeta('sampleLoaded') && !confirm('サンプルは読み込み済みです。もう一度追加しますか？')) return;
  const prevJinken = newEvent({ title: '人権・同和教育参観日', date: '2025-11-27', startTime: '13:30', endTime: '14:20', place: '各教室', category: '道徳', handover: '配付資料は1週間前に学年主任と確認すると余裕がある。\n板書案は2日前までに作り、学年で見せ合うとよい。\n保護者アンケートは授業の最後に5分とって当日回収。' });
  const jinken = newEvent({ title: '人権・同和教育参観日', date: '2026-11-26', startTime: '13:30', endTime: '14:20', place: '各教室', category: '道徳', sourceId: prevJinken.id, memo: '保護者アンケートを印刷して持っていく。' });
  const chorus = newEvent({ title: '合唱コンクール', date: '2025-10-30', place: '体育館', category: '学級・学年', handover: '曲決めは3週間前では遅かった。夏休み明けすぐに決めたい。\n指揮者・伴奏者の練習時間を朝に確保する。' });
  const test = newEvent({ title: '期末テスト問題 提出', date: '2026-11-27', category: '校務', kind: '締切' });
  const kenkyu = newEvent({ title: '国語 研究授業（2年1組）', date: '2026-12-03', startTime: '13:30', place: '2年1組', category: '国語', kind: '授業' });
  const dayori = newEvent({ title: '学年だより12月号', category: '学級・学年' });
  for (const e of [prevJinken, jinken, chorus, test, kenkyu, dayori]) await save('events', e);
  const preps = [
    newPrep({ eventId: prevJinken.id, title: '配付資料の確認', due: '2025-11-20', offset: 7, done: true }),
    newPrep({ eventId: prevJinken.id, title: '板書案の作成', due: '2025-11-25', offset: 2, done: true }),
    newPrep({ eventId: jinken.id, title: '配付資料の確認', due: '2026-11-19', offset: 7 }),
    newPrep({ eventId: jinken.id, title: '板書案の作成', due: '2026-11-24', offset: 2 }),
    newPrep({ eventId: chorus.id, title: '自由曲の決定', due: '2025-10-09', offset: 21, done: true }),
    newPrep({ eventId: chorus.id, title: 'リハーサル計画の配付', due: '2025-10-23', offset: 7, done: true }),
    newPrep({ eventId: kenkyu.id, title: '指導案の提出', due: '2026-11-26', offset: 7 }),
    newPrep({ eventId: kenkyu.id, title: 'ワークシート印刷', due: '2026-12-01', offset: 2 }),
  ];
  for (const p of preps) await save('preps', p);
  await setMeta('sampleLoaded', true);
  toast('サンプルを読み込みました');
  location.hash = '#/week'; rerender();
}

/* ---------- 操作の受け付け ---------- */
const ACT = {
  'quick-add': (el) => openQuickAdd(el.dataset.date || (location.hash.startsWith('#/month') ? new URLSearchParams(location.hash.split('?')[1] || '').get('d') : '')),
  'qa-cat': (el) => { qaCat = qaCat === el.dataset.val ? '' : el.dataset.val; $$('#qa-cats button').forEach((b) => b.classList.toggle('on', b.dataset.val === qaCat)); },
  'qa-save': (el) => quickSave(!!el.dataset.detail),
  'close-sheet': () => { if (confirmDiscard()) closeSheet(true); },
  back: () => { location.hash = lastListHash || '#/week'; },
  'set-seg': async (el) => {
    const ev = S.events.get(currentEventId); const f = el.dataset.field;
    ev[f] = el.dataset.val; await save('events', ev);
    $$(`[data-act="set-seg"][data-field="${f}"]`).forEach((b) => b.classList.toggle('on', b === el));
    toast('保存しました');
  },
  'clear-date': () => changeEventDate(S.events.get(currentEventId), null),
  'shift-apply': (el) => applyShift(el.dataset.mode),
  'add-prep': () => addPrep(false),
  'del-prep': async (el) => {
    const p = S.preps.get(el.dataset.id);
    if (!confirm(`準備「${p.title}」を削除しますか？`)) return;
    await removeRec('preps', p.id); refreshPrepSection(); toast('削除しました');
  },
  'add-link': openLinkSheet,
  'save-link': saveLink,
  'open-att': (el) => {
    const a = S.attachments.get(el.dataset.id);
    if (a.type === 'link') window.open(a.url, '_blank', 'noopener'); else openViewer(a);
  },
  'del-att': async (el) => {
    const a = S.attachments.get(el.dataset.id);
    if (!confirm(`資料「${a.name}」とそのメモを削除しますか？`)) return;
    await deleteAttachment(a); refreshAttSection(); toast('削除しました');
  },
  'delete-event': () => deleteEvent(S.events.get(currentEventId)),
  'close-viewer': closeViewer,
  'pin-image': (el, e) => {
    const r = el.getBoundingClientRect();
    V.pin = { x: Math.round(((e.clientX - r.left) / r.width) * 1000) / 10, y: Math.round(((e.clientY - r.top) / r.height) * 1000) / 10 };
    renderDoc(); renderNotes(); $('#note-text').focus({ preventScroll: true });
  },
  unpin: () => { V.pin = null; renderDoc(); renderNotes(); },
  'pdf-page': (el) => {
    const np = V.page + Number(el.dataset.d);
    if (np < 1 || (V.pages && np > V.pages)) return;
    V.page = np; renderNotes();
    if (V.pdfFailed) $('#pdf-pg').textContent = `${V.page} ページ`; else renderPdf();
  },
  'pdf-goto': (el) => { V.page = Number(el.dataset.p); renderNotes(); if (V.pdfFailed) $('#pdf-pg').textContent = `${V.page} ページ`; else renderPdf(); },
  'add-note': addNote,
  'edit-note': (el) => editNote(el.dataset.id),
  'note-save': async (el) => {
    const n = S.notes.get(el.dataset.id); const t = $('#en-text').value.trim();
    if (!t) { toast('メモが空です'); return; }
    n.text = t; await save('notes', n); closeSheet(false); renderDoc(); renderNotes(); toast('保存しました');
  },
  'note-del': async (el) => {
    if (!confirm('このメモを削除しますか？')) return;
    await removeRec('notes', el.dataset.id); closeSheet(false); renderDoc(); renderNotes(); toast('削除しました');
  },
  'cf-seg': (el) => { CF.category = el.dataset.val; $$('[data-act="cf-seg"]').forEach((b) => b.classList.toggle('on', b === el)); },
  'cf-add-prep': () => { CF.preps.push({ title: '', offset: null, due: null, include: true }); $('#cf-preps').innerHTML = cfPrepsHtml(); },
  'cf-save': saveCopy,
  'bulk-parse': () => {
    BULK = parseBulk($('#bulk-text').value, Number($('#bulk-fy').value));
    $('#bulk-cands').innerHTML = bulkCandsHtml() || '<section class="card"><p class="empty">読み取れる行がありませんでした。</p></section>';
  },
  'bulk-save': async () => {
    const items = BULK.filter((c) => c.include && c.title.trim());
    if (!items.length) { toast('登録する項目にチェックを入れてください'); return; }
    for (const c of items) await save('events', newEvent({ title: c.title.trim(), date: c.date || null, place: c.place, startTime: c.startTime, category: c.category }));
    BULK = [];
    toast(`${items.length}件を登録しました`);
    location.hash = '#/month';
  },
  backup: exportBackup,
  persist: async () => {
    try { const ok = await navigator.storage.persist(); toast(ok ? '許可されました' : 'ブラウザに許可されませんでした（ホーム画面に追加すると許可されやすくなります）'); } catch { toast('このブラウザでは設定できません'); }
    fillStorageInfo();
  },
  'load-sample': loadSample,
  wipe: async () => {
    if (!confirm('この端末のすべての予定・準備・資料を削除します。元に戻せません。よろしいですか？')) return;
    if (!confirm('本当に削除しますか？（バックアップは保存しましたか？）')) return;
    for (const s of STORES) await DB.clear(s);
    await loadAll(); toast('すべて削除しました'); location.hash = '#/week'; rerender();
  },
};

const ACT_CHANGE = {
  'toggle-prep': async (el) => {
    const p = S.preps.get(el.dataset.id);
    p.done = el.checked; p.doneAt = p.done ? Date.now() : null;
    await save('preps', p);
    toast(p.done ? `「${p.title}」を完了にしました` : '未完了に戻しました');
    if (currentEventId) refreshPrepSection(); else rerender();
  },
  'set-date': async (el) => {
    const ev = S.events.get(el.dataset.id);
    if (!el.value) return;
    ev.date = el.value; await save('events', ev); await recalcOffsets(ev);
    toast(`${fmtMD(ev.date)}に移しました`); rerender();
  },
  'add-files': addFiles,
  'copy-fy': (el) => { location.hash = `#/copy?fy=${el.value}`; },
  restore: restoreBackup,
};

document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act && !['INPUT', 'SELECT', 'TEXTAREA'].includes(act.tagName) && ACT[act.dataset.act]) {
    e.preventDefault();
    Promise.resolve(ACT[act.dataset.act](act, e)).catch((err) => { console.error(err); toast('エラーが起きました'); });
    return;
  }
  const rep = e.target.closest('[data-replace]');
  if (rep) { e.preventDefault(); location.replace(rep.dataset.replace); return; }
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); if (V) closeViewer(); if (!$('#sheet').hidden) closeSheet(false); location.hash = go.dataset.go; }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act && ACT_CHANGE[el.dataset.act]) { Promise.resolve(ACT_CHANGE[el.dataset.act](el)).catch((err) => { console.error(err); toast('エラーが起きました'); }); return; }
  if (el.dataset.field) { const t = fieldTimers.get(el.dataset.field); if (t) clearTimeout(t.timer); fieldTimers.delete(el.dataset.field); onFieldChange(el); return; }
  if (el.dataset.prepField) {
    const p = S.preps.get(el.dataset.id); const ev = S.events.get(p.eventId);
    if (el.dataset.prepField === 'title') {
      const v = el.value.trim(); if (!v) { el.value = p.title; return; }
      p.title = v; save('preps', p).then(() => toast('保存しました'));
    } else {
      p.due = el.value || null;
      if (p.due && ev.date) p.offset = diffDays(ev.date, p.due);
      save('preps', p).then(() => { refreshPrepSection(); toast(p.due ? `期限を${fmtMD(p.due)}にしました` : '期限を未定にしました'); });
    }
    return;
  }
  if (el.dataset.cf && CF) {
    const k = el.dataset.cf;
    if (k === 'memo') { CF.memo = el.checked; return; }
    CF[k] = el.value;
    if (k === 'date') {
      CF.date = el.value || null;
      CF.preps.forEach((p) => { if (p.offset != null && CF.date) p.due = addDays(CF.date, -p.offset); });
      $('#cf-preps').innerHTML = cfPrepsHtml();
    }
    return;
  }
  if (el.dataset.cfAtt && CF) { CF.atts[el.dataset.cfAtt] = el.checked; return; }
  if (el.dataset.cfp && CF) {
    const p = CF.preps[Number(el.dataset.i)]; const k = el.dataset.cfp;
    const row = el.closest('.cf-prep');
    if (k === 'include') { p.include = el.checked; row.classList.toggle('off', !p.include); }
    else if (k === 'title') p.title = el.value;
    else if (k === 'offset') {
      p.offset = el.value === '' ? null : Number(el.value);
      if (p.offset != null && CF.date) { p.due = addDays(CF.date, -p.offset); $('[data-cfp="due"]', row).value = p.due; }
    } else if (k === 'due') {
      p.due = el.value || null;
      if (p.due && CF.date) { p.offset = diffDays(CF.date, p.due); $('[data-cfp="offset"]', row).value = p.offset; }
    }
    return;
  }
  if (el.dataset.bulk) {
    const c = BULK[Number(el.dataset.i)];
    c[el.dataset.bulk] = el.type === 'checkbox' ? el.checked : el.value;
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.field && el.dataset.field !== 'date' && el.type !== 'time') scheduleFieldSave(el);
  if (el.dataset.cf === 'title' && CF) CF.title = el.value;
  if (el.id === 'copy-kw') {
    copyKw = el.value;
    const sel = $('[data-act="copy-fy"]').value;
    $('#copy-list').innerHTML = copyListHtml(sel);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    if (e.target.id === 'qa-title') { e.preventDefault(); quickSave(false); }
    if (e.target.id === 'np-title' || e.target.id === 'np-off') { e.preventDefault(); addPrep(false); }
  }
  if (e.key === 'Escape') { if (!$('#sheet').hidden) closeSheet(true); else if (V) closeViewer(); }
});
function confirmDiscard() {
  const t = $('#qa-title') || $('#lk-url');
  return !(t && t.value.trim()) || confirm('入力中の内容はまだ登録されていません。閉じてもよいですか？\n（登録するときは「登録する」を押してください）');
}
$('#sheet-backdrop').addEventListener('click', () => { if (confirmDiscard()) closeSheet(true); });
window.addEventListener('hashchange', async () => {
  // 画面を描き替える前に、前の画面で入力途中だったものを保存（currentEventId は前の画面のまま）
  if (currentEventId) await flushPending();
  if (V) closeViewer();
  render();
});
// 画面を離れる前に、入力途中の文字を保存
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPending();
});
window.addEventListener('pagehide', () => { flushPending(); });
let lastDay = today();
setInterval(() => { if (today() !== lastDay) { lastDay = today(); if (!currentEventId && !V && $('#sheet').hidden) rerender(); } }, 60000);

/* ---------- 起動 ---------- */
(async function start() {
  try {
    await DB.open();
    await loadAll();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = '<section class="card box warn"><h2>データを保存できません</h2><p>このブラウザでは端末内への保存が使えないようです（プライベートブラウズ等）。通常のウィンドウで開いてください。</p></section>';
    return;
  }
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
  if (navigator.storage?.persisted && S.events.size > 0) {
    try { if (!(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* 無視 */ }
  }
})();
