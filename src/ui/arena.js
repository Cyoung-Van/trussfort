// 桁垒 TRUSSFORT — 「对战回放」面板：列出 arena/index.json 里记录的比赛，点任意一局观看。
// 只负责列表和选择；真正载入堡垒、开战由 main.js 的 playRecorded 完成。

import { ICON } from './icons.js';

const REASON = { coreDestroyed: '核心被毁', coreSunk: '核心落水', timeout: '到时判定', stalemate: '双方失去火力' };

/** 对决条和列表里用的短名：选手 id 首字母大写（hydrogen → Hydrogen） */
export const shortName = (p) => (p && p.id ? p.id.charAt(0).toUpperCase() + p.id.slice(1) : '?');

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export class ArenaPanel {
  /**
   * @param {{ root: HTMLElement, onPlay: (match: object, roundIndex: number, gameIndex: number) => void, onDismiss?: () => void }} o
   *   onDismiss：用户自己关掉面板（点 ×、点空白、按 Esc）时调用，用来作废还在路上的回放请求
   */
  constructor({ root, onPlay, onDismiss }) {
    this.onPlay = onPlay;
    this.onDismiss = onDismiss;
    this.isOpen = false;
    this._index = null;      // Promise<index>
    this._rendered = false;

    this.box = el('div', 'arena pe', root);
    this.box.addEventListener('pointerdown', (e) => { if (e.target === this.box) this.dismiss(); });
    const card = el('div', 'panel arena-card', this.box);
    const head = el('div', 'ar-head', card);
    const ht = el('div', '', head);
    el('div', 'ar-title', ht, '对战回放');
    el('div', 'ar-sub', ht, 'AI 模型各自设计一座堡垒，引擎自动对战。点任意一局观看。');
    const x = el('button', 'btn icon-btn sm', head);
    x.type = 'button'; x.tabIndex = -1; x.title = '关闭（Esc）'; x.setAttribute('aria-label', '关闭');
    x.innerHTML = ICON.close;
    x.addEventListener('click', () => this.dismiss());
    this.body = el('div', 'ar-body', card);
  }

  /** 读取比赛清单（只读一次）。双击打开（file://）时浏览器不让读文件，会被拒绝。 */
  load() {
    if (!this._index) {
      this._index = /^https?:$/.test(location.protocol)
        ? fetch('arena/index.json').then((r) => { if (!r.ok) throw new Error(`读不到比赛清单（${r.status}）`); return r.json(); })
        : Promise.reject(new Error('file'));
      this._index.catch(() => { this._index = null; });   // 失败后下次打开再试
    }
    return this._index;
  }

  open() {
    this.isOpen = true;
    this.box.classList.add('on');
    if (this._rendered) return;
    this.body.textContent = '';
    el('div', 'ar-msg', this.body, '正在读取比赛记录…');
    this.load().then((idx) => this._render(idx), (e) => {
      this.body.textContent = '';
      const m = el('div', 'ar-msg', this.body);
      if (e && e.message === 'file') {
        m.append('双击打开时浏览器不允许读取比赛记录。', el('br'), '请打开在线版，或在项目目录运行 node tools/serve.mjs 5173 后访问 localhost:5173。');
      } else m.textContent = `读取失败：${e && e.message ? e.message : e}`;
    });
  }

  close() {
    this.isOpen = false;
    this.box.classList.remove('on');
  }

  /** 用户主动关掉面板 */
  dismiss() {
    this.close();
    if (this.onDismiss) this.onDismiss();
  }

  _render(idx) {
    this.body.textContent = '';
    const matches = (idx && idx.matches) || [];
    if (!matches.length) { el('div', 'ar-msg', this.body, '还没有比赛记录。'); return; }
    matches.forEach((m, mi) => {
      const names = m.players.map(shortName);
      const d = el('details', 'ar-match', this.body);
      if (mi === 0) d.open = true;
      const s = el('summary', '', d);
      el('span', 'ar-date', s, m.date);
      const vs = el('span', 'ar-vs', s);
      el('span', m.winner === 0 ? 'won' : 'lost', vs, names[0]);
      el('span', 'ar-score', vs, `${m.score[0]} : ${m.score[1]}`);
      el('span', m.winner === 1 ? 'won' : 'lost', vs, names[1]);
      const chev = el('span', 'ar-chev', s);
      chev.innerHTML = ICON.chev;
      el('span', 'ar-models', s, `${m.players[0].label} 对 ${m.players[1].label}`);

      m.rounds.forEach((r, ri) => {
        const box = el('div', 'ar-round', d);
        const rh = el('div', 'ar-rhead', box);
        el('span', '', rh, `第 ${r.round} 轮${r.round === 1 ? ' · 盲设计' : ''}`);
        el('span', 'ar-rscore', rh, `${r.score[0]} : ${r.score[1]}`);
        if (r.note) el('div', 'ar-note', box, r.note);
        r.games.forEach((g, gi) => {
          const b = el('button', 'btn ar-game', box);
          b.type = 'button'; b.tabIndex = -1;
          el('span', 'ar-gno', b, `第 ${gi + 1} 局`);
          const sides = el('span', 'ar-sides', b);
          el('span', 'l', sides, names[g.left]);
          el('span', 'x', sides, ' 对 ');
          el('span', 'r', sides, names[1 - g.left]);
          const who = g.winner == null ? '平局' : `${names[g.winner]} 胜`;
          el('span', 'ar-res', b, `${who} · ${REASON[g.reason] || g.reason} · ${g.seconds} 秒`);
          const pl = el('span', 'ar-play', b);
          pl.innerHTML = ICON.play;
          b.addEventListener('click', () => { if (this.onPlay) this.onPlay(m, ri, gi); });
        });
      });
    });
    this._rendered = true;
  }
}
