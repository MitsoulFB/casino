'use strict';

/* ============================================================
   ROULETTE EUROPÉENNE — client de la table partagée
   ------------------------------------------------------------
   Ce script ne décide plus de rien : le serveur (server.js) fait
   autorité sur le tirage, la phase de mise chronométrée, le lancer
   de la roue et les gains de chaque joueur. Le client se contente
   d'envoyer les actions du joueur (mise, annulation, pseudo…) et de
   rendre à l'écran chaque "state" reçu par websocket. Reconnexion
   automatique en cas de coupure, avec resynchronisation complète.

   Règles / paiements (affichage uniquement — calculés côté serveur) :
     - Plein (straight)        35:1
     - Cheval / split          17:1
     - Transversale / street   11:1
     - Carré / corner           8:1
     - Chances simples          1:1  (rouge/noir, pair/impair, manque/passe)
     - Douzaines / colonnes     2:1
   ============================================================ */

// Ordre réel des cases sur une roue européenne (sens horaire) — uniquement
// pour l'animation visuelle de la roue, aucune conséquence sur le tirage
// (qui est décidé par le serveur).
const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const POCKET_COUNT = WHEEL_ORDER.length; // 37
const POCKET_ANGLE = 360 / POCKET_COUNT;

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const PLAYER_ID_KEY = 'maison21_roulette_playerId';
const BANKROLL_CACHE_KEY = 'maison21_roulette_bankroll'; // simple cache d'affichage hors-ligne
const HISTORY_MAX = 12;
const MAX_TOKENS_SHOWN = 3; // au-delà, on affiche "+N" sur la case

// ---------- Identité persistante du navigateur ----------
function loadOrCreatePlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}
const myPlayerId = loadOrCreatePlayerId();

function cacheBankroll(n) {
  try { localStorage.setItem(BANKROLL_CACHE_KEY, String(n)); } catch { /* ignore */ }
}
function loadCachedBankroll() {
  const n = parseInt(localStorage.getItem(BANKROLL_CACHE_KEY), 10);
  return Number.isFinite(n) ? n : 1000;
}

// ---------- DOM refs ----------
const els = {
  bankroll: document.getElementById('bankroll'),
  bankrollPill: document.querySelector('.bankroll-pill'),
  playersCount: document.getElementById('playersCount'),
  playersPill: document.getElementById('playersPill'),
  connDot: document.getElementById('connDot'),
  profileBtn: document.getElementById('profileBtn'),
  myNameLabel: document.getElementById('myNameLabel'),
  betAmount: document.getElementById('betAmount'),
  chipRack: document.getElementById('chipRack'),
  undoBetBtn: document.getElementById('undoBetBtn'),
  clearBetBtn: document.getElementById('clearBetBtn'),
  readyBtn: document.getElementById('readyBtn'),
  betZone: document.getElementById('betZone'),
  gameActions: document.getElementById('gameActions'),
  waitingNote: document.getElementById('waitingNote'),
  board: document.getElementById('board'),
  statusMessage: document.getElementById('statusMessage'),
  bettingTimer: document.getElementById('bettingTimer'),
  toast: document.getElementById('toast'),
  rulesBtn: document.getElementById('rulesBtn'),
  closeRulesBtn: document.getElementById('closeRulesBtn'),
  rulesModal: document.getElementById('rulesModal'),
  // Classement (leaderboard)
  leaderboardBtn: document.getElementById('leaderboardBtn'),
  leaderboardModal: document.getElementById('leaderboardModal'),
  closeLeaderboardBtn: document.getElementById('closeLeaderboardBtn'),
  leaderboardList: document.getElementById('leaderboardList'),
  profileModal: document.getElementById('profileModal'),
  closeProfileBtn: document.getElementById('closeProfileBtn'),
  nameInput: document.getElementById('nameInput'),
  saveNameBtn: document.getElementById('saveNameBtn'),
  dealerCallout: document.getElementById('dealerCallout'),
  wheel: document.getElementById('wheel'),
  ballPivot: document.getElementById('ballPivot'),
  historyStrip: document.getElementById('historyStrip'),
  soundBtn: document.getElementById('soundBtn'),
};

// ---------- État local (purement d'affichage) ----------
let latestState = null;
let lastPhase = null;
let selectedChip = 5;
let wheelRotation = 0; // rotation cumulée de la roue (deg), locale à ce client
let ballRotation = 0;  // rotation cumulée de la bille (deg), locale à ce client
let dealerCalloutTimer = null;
let bettingTickInterval = null;
let hotspotDefs = [];       // définitions géométriques des mises à cheval / carré
let lastRenderedBetIds = new Set(); // pour nettoyer les cases qui n'ont plus de mise
let lastHistorySignature = '';
let lastBankrollShown = null;

// ---------- Numéro : couleur / parité / manque-passe ----------
function numberColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// ---------- Mises : numéros couverts / condition de gain ----------
// (Le calcul des gains reste côté serveur ; on garde juste de quoi savoir
// quelles cases surligner en vert/rouge à la résolution.)
function betNums(betId) {
  const dash = betId.indexOf('-');
  return betId.slice(dash + 1).split('-').map(Number);
}
function betWins(betId, n) {
  if (betId.startsWith('straight-')) return betNums(betId)[0] === n;
  if (betId.startsWith('split-') || betId.startsWith('corner-') || betId.startsWith('street-')) {
    return betNums(betId).includes(n);
  }
  switch (betId) {
    case 'red': return n !== 0 && numberColor(n) === 'red';
    case 'black': return n !== 0 && numberColor(n) === 'black';
    case 'even': return n !== 0 && n % 2 === 0;
    case 'odd': return n !== 0 && n % 2 === 1;
    case 'low': return n >= 1 && n <= 18;
    case 'high': return n >= 19 && n <= 36;
    case 'dozen-1': return n >= 1 && n <= 12;
    case 'dozen-2': return n >= 13 && n <= 24;
    case 'dozen-3': return n >= 25 && n <= 36;
    case 'col-1': return n !== 0 && n % 3 === 1;
    case 'col-2': return n !== 0 && n % 3 === 2;
    case 'col-3': return n !== 0 && n % 3 === 0;
    default: return false;
  }
}

// ---------- Construction des définitions de mises à cheval / carré / transversale ----------
// Grille du tapis : colonne c (1..12) contient les numéros
//   haut  = 3c    (rangée du haut)
//   milieu= 3c-1
//   bas   = 3c-2  (rangée du bas, "1re rangée" — adjacente au 0)
function buildHotspotDefs() {
  const defs = [];
  const splitIds = new Set();
  const cornerIds = new Set();

  function addSplit(a, b, geom) {
    const nums = [a, b].sort((x, y) => x - y);
    const id = `split-${nums.join('-')}`;
    if (splitIds.has(id)) return;
    splitIds.add(id);
    defs.push({ id, kind: 'split', geom });
  }
  function addCorner(topLeft, topRight, botLeft, botRight) {
    const nums = [topLeft, topRight, botLeft, botRight].sort((x, y) => x - y);
    const id = `corner-${nums.join('-')}`;
    if (cornerIds.has(id)) return;
    cornerIds.add(id);
    defs.push({ id, kind: 'corner', geom: { type: 'corner', topLeft, topRight, botLeft, botRight } });
  }

  for (let c = 1; c <= 12; c++) {
    const top = 3 * c, mid = 3 * c - 1, bot = 3 * c - 2;
    addSplit(top, mid, { type: 'v', top, bottom: mid });
    addSplit(mid, bot, { type: 'v', top: mid, bottom: bot });
    if (c < 12) {
      const top2 = 3 * (c + 1), mid2 = 3 * (c + 1) - 1, bot2 = 3 * (c + 1) - 2;
      addSplit(top, top2, { type: 'h', left: top, right: top2 });
      addSplit(mid, mid2, { type: 'h', left: mid, right: mid2 });
      addSplit(bot, bot2, { type: 'h', left: bot, right: bot2 });
      addCorner(top, top2, mid, mid2);
      addCorner(mid, mid2, bot, bot2);
    }
  }
  // Mises à cheval avec le zéro (0-1, 0-2, 0-3)
  addSplit(0, 1, { type: 'zero', num: 1 });
  addSplit(0, 2, { type: 'zero', num: 2 });
  addSplit(0, 3, { type: 'zero', num: 3 });

  return defs;
}

// ---------- Construction du tapis ----------
function buildBoard() {
  els.board.innerHTML = '';

  const boardMain = document.createElement('div');
  boardMain.className = 'board-main';

  // Colonne du zéro
  const zeroCol = document.createElement('div');
  zeroCol.className = 'zero-col';
  zeroCol.appendChild(makeCell('straight-0', '0', ['zero-cell']));
  boardMain.appendChild(zeroCol);

  // Grille des numéros + transversales
  const gridCol = document.createElement('div');
  gridCol.className = 'grid-col';

  const gridWrap = document.createElement('div');
  gridWrap.className = 'grid-wrap';
  gridWrap.id = 'gridWrap';

  const grid = document.createElement('div');
  grid.className = 'number-grid';
  grid.id = 'numberGrid';
  for (let n = 1; n <= 36; n++) {
    const colorClass = numberColor(n) === 'red' ? 'num-red' : 'num-black';
    const cell = makeCell(`straight-${n}`, String(n), [colorClass]);
    const col = Math.ceil(n / 3);
    const rem = n % 3;
    const row = rem === 0 ? 1 : rem === 2 ? 2 : 3;
    cell.style.gridColumn = String(col);
    cell.style.gridRow = String(row);
    grid.appendChild(cell);
  }
  gridWrap.appendChild(grid);

  const hotspotLayer = document.createElement('div');
  hotspotLayer.className = 'hotspot-layer';
  hotspotLayer.id = 'hotspotLayer';
  hotspotDefs = buildHotspotDefs();
  hotspotDefs.forEach((def) => {
    const nums = betNums(def.id);
    const el = document.createElement('div');
    el.className = `hotspot ${def.kind === 'corner' ? 'hotspot-corner' : 'hotspot-split'}`;
    el.dataset.bet = def.id;
    el.title = `${def.kind === 'corner' ? 'Carré' : 'Cheval'} ${nums.join('-')} (${def.kind === 'corner' ? '8:1' : '17:1'})`;
    el.innerHTML = '<span class="bet-tokens"></span><span class="bet-badge"></span>';
    el.addEventListener('click', () => placeBet(def.id));
    def.el = el;
    hotspotLayer.appendChild(el);
  });
  gridWrap.appendChild(hotspotLayer);
  gridCol.appendChild(gridWrap);

  const streetRow = document.createElement('div');
  streetRow.className = 'street-row';
  streetRow.id = 'streetRow';
  for (let c = 1; c <= 12; c++) {
    const top = 3 * c, mid = 3 * c - 1, bot = 3 * c - 2;
    const id = `street-${[bot, mid, top].sort((x, y) => x - y).join('-')}`;
    const el = document.createElement('div');
    el.className = 'street-cell';
    el.dataset.bet = id;
    el.title = `Transversale ${bot}-${mid}-${top} (11:1)`;
    el.innerHTML = '<span class="bet-tokens"></span><span class="bet-badge"></span>';
    el.addEventListener('click', () => placeBet(id));
    streetRow.appendChild(el);
  }
  gridCol.appendChild(streetRow);
  boardMain.appendChild(gridCol);

  // Colonnes 2:1
  const colBets = document.createElement('div');
  colBets.className = 'column-bets';
  colBets.appendChild(makeCell('col-3', '2:1'));
  colBets.appendChild(makeCell('col-2', '2:1'));
  colBets.appendChild(makeCell('col-1', '2:1'));
  boardMain.appendChild(colBets);

  els.board.appendChild(boardMain);

  // Douzaines
  const dozensRow = document.createElement('div');
  dozensRow.className = 'dozens-row';
  dozensRow.appendChild(makeCell('dozen-1', '1er 12'));
  dozensRow.appendChild(makeCell('dozen-2', '2e 12'));
  dozensRow.appendChild(makeCell('dozen-3', '3e 12'));
  els.board.appendChild(dozensRow);

  // Chances simples
  const outsideRow = document.createElement('div');
  outsideRow.className = 'outside-row';
  outsideRow.appendChild(makeCell('low', '1-18'));
  outsideRow.appendChild(makeCell('even', 'PAIR'));
  outsideRow.appendChild(makeCell('red', 'ROUGE', ['outside-red']));
  outsideRow.appendChild(makeCell('black', 'NOIR', ['outside-black']));
  outsideRow.appendChild(makeCell('odd', 'IMPAIR'));
  outsideRow.appendChild(makeCell('high', '19-36'));
  els.board.appendChild(outsideRow);

  positionHotspots();
}

function makeCell(betId, label, extraClasses = []) {
  const cell = document.createElement('div');
  cell.className = ['cell', ...extraClasses].join(' ');
  cell.dataset.bet = betId;
  cell.innerHTML = `<span class="cell-label">${label}</span><span class="bet-tokens"></span><span class="bet-badge"></span>`;
  cell.addEventListener('click', () => placeBet(betId));
  return cell;
}

function cellFor(betId) {
  return els.board.querySelector(`[data-bet="${betId}"]`);
}

// ---------- Positionnement dynamique des carrés / chevaux ----------
function positionHotspots() {
  const gridWrap = document.getElementById('gridWrap');
  if (!gridWrap || hotspotDefs.length === 0) return;
  const wrapRect = gridWrap.getBoundingClientRect();
  if (wrapRect.width === 0) return; // pas encore rendu (ex: onglet caché)

  const rectCache = new Map();
  function rectOf(n) {
    if (rectCache.has(n)) return rectCache.get(n);
    const el = cellFor(`straight-${n}`);
    const r = el.getBoundingClientRect();
    const rel = {
      left: r.left - wrapRect.left,
      top: r.top - wrapRect.top,
      right: r.right - wrapRect.left,
      bottom: r.bottom - wrapRect.top,
      cx: r.left - wrapRect.left + r.width / 2,
      cy: r.top - wrapRect.top + r.height / 2,
    };
    rectCache.set(n, rel);
    return rel;
  }
  function zeroRect() {
    const el = cellFor('straight-0');
    const r = el.getBoundingClientRect();
    return { right: r.right - wrapRect.left };
  }

  hotspotDefs.forEach((def) => {
    const g = def.geom;
    let x, y;
    if (g.type === 'v') {
      const t = rectOf(g.top), b = rectOf(g.bottom);
      x = t.cx;
      y = (t.bottom + b.top) / 2;
    } else if (g.type === 'h') {
      const l = rectOf(g.left), r = rectOf(g.right);
      x = (l.right + r.left) / 2;
      y = l.cy;
    } else if (g.type === 'corner') {
      const tl = rectOf(g.topLeft), tr = rectOf(g.topRight), bl = rectOf(g.botLeft);
      x = (tl.right + tr.left) / 2;
      y = (tl.bottom + bl.top) / 2;
    } else if (g.type === 'zero') {
      const num = rectOf(g.num);
      x = (zeroRect().right + num.left) / 2;
      y = num.cy;
    }
    if (def.el && Number.isFinite(x) && Number.isFinite(y)) {
      def.el.style.left = `${x}px`;
      def.el.style.top = `${y}px`;
    }
  });
}

let resizeRaf = null;
function scheduleReposition() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(positionHotspots);
}
window.addEventListener('resize', scheduleReposition);
window.addEventListener('orientationchange', scheduleReposition);

// ---------- Construction de la roue ----------
function buildWheel() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < POCKET_COUNT; i++) {
    const n = WHEEL_ORDER[i];
    const angle = i * POCKET_ANGLE;
    const color = numberColor(n);
    const el = document.createElement('div');
    el.className = `wheel-number wn-${color}`;
    el.style.transform = `rotate(${angle}deg)`;
    el.innerHTML = `<span>${n}</span>`;
    frag.appendChild(el);
  }
  els.wheel.appendChild(frag);

  const seg = 360 / POCKET_COUNT;
  const segPct = 100 / POCKET_COUNT;
  const stops = [];
  for (let i = 0; i < POCKET_COUNT; i++) {
    const n = WHEEL_ORDER[i];
    const color = numberColor(n);
    const c = color === 'red' ? 'var(--pocket-red)' : color === 'black' ? 'var(--pocket-black)' : 'var(--pocket-green)';
    const start = (i * segPct).toFixed(4);
    const end = ((i + 1) * segPct).toFixed(4);
    stops.push(`${c} ${start}% ${end}%`);
  }
  const colorGradient = `conic-gradient(from ${-seg / 2}deg, ${stops.join(', ')})`;
  const dividerGradient = `repeating-conic-gradient(from ${-seg / 2}deg, rgba(20,12,4,0.9) 0deg 0.5deg, transparent 0.5deg ${seg}deg)`;
  els.wheel.style.background = `${dividerGradient}, ${colorGradient}`;
}

// ---------- Identité visuelle des joueurs (jetons sur le tapis) ----------
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

// ---------- Agrégation des mises de tous les joueurs, par case ----------
function computeAggregatedBets(state) {
  const map = new Map(); // betId -> { total, byPlayer: [{id, name, amount, isMe}] }
  state.players.forEach((p) => {
    Object.entries(p.bets || {}).forEach(([betId, amount]) => {
      if (!map.has(betId)) map.set(betId, { total: 0, byPlayer: [] });
      const entry = map.get(betId);
      entry.total += amount;
      entry.byPlayer.push({ id: p.id, name: p.name, amount, isMe: p.id === myPlayerId });
    });
  });
  return map;
}

function updateCellBetBadge(cell, data) {
  const badge = cell.querySelector('.bet-badge');
  if (!badge) return;
  const amount = data ? data.total : 0;
  if (amount > 0) {
    badge.textContent = amount >= 1000 ? `${(amount / 1000).toFixed(1)}k` : amount;
    badge.classList.add('show');
  } else {
    badge.textContent = '';
    badge.classList.remove('show');
  }
}

function updateCellPlayerTokens(cell, data) {
  const container = cell.querySelector('.bet-tokens');
  if (!container) return;
  container.innerHTML = '';
  if (!data || data.byPlayer.length === 0) return;
  // La mise du joueur courant est toujours affichée en premier (mise en avant dorée).
  const list = [...data.byPlayer].sort((a, b) => (b.isMe - a.isMe));
  list.slice(0, MAX_TOKENS_SHOWN).forEach((entry) => {
    const tok = document.createElement('span');
    tok.className = 'bet-token' + (entry.isMe ? ' mine' : '');
    if (!entry.isMe) tok.style.background = `hsl(${hashHue(entry.id)}, 58%, 42%)`;
    tok.textContent = initialsOf(entry.name);
    tok.title = `${entry.isMe ? 'Vous' : entry.name} — ${entry.amount.toLocaleString('fr-FR')} jetons`;
    container.appendChild(tok);
  });
  if (list.length > MAX_TOKENS_SHOWN) {
    const extra = list.slice(MAX_TOKENS_SHOWN);
    const more = document.createElement('span');
    more.className = 'bet-token overflow';
    more.textContent = `+${extra.length}`;
    more.title = extra.map((e) => `${e.name} — ${e.amount.toLocaleString('fr-FR')} jetons`).join(' · ');
    container.appendChild(more);
  }
}

function renderBoardBets(state) {
  const agg = computeAggregatedBets(state);
  const allIds = new Set([...agg.keys(), ...lastRenderedBetIds]);
  allIds.forEach((betId) => {
    const cell = cellFor(betId);
    if (!cell) return;
    const data = agg.get(betId) || null;
    updateCellBetBadge(cell, data);
    updateCellPlayerTokens(cell, data);
  });
  lastRenderedBetIds = new Set(agg.keys());
  return agg;
}

// ---------- Rendu / UI ----------
function myPlayer(state) {
  return state.players.find((p) => p.id === myPlayerId) || null;
}

function updateBankrollDisplay(bankroll) {
  if (bankroll !== lastBankrollShown) {
    lastBankrollShown = bankroll;
    els.bankrollPill.classList.remove('bump');
    void els.bankrollPill.offsetWidth;
    els.bankrollPill.classList.add('bump');
  }
  els.bankroll.textContent = bankroll.toLocaleString('fr-FR');
}

function updateBetDisplay(state) {
  const me = myPlayer(state);
  const total = me ? me.totalBet : 0;
  els.betAmount.textContent = total.toLocaleString('fr-FR');
}

function updateChipAvailability(state) {
  const me = myPlayer(state);
  const bankroll = me ? me.bankroll : loadCachedBankroll();
  const total = me ? me.totalBet : 0;
  const remaining = bankroll - total;
  els.chipRack.querySelectorAll('.chip').forEach((chip) => {
    const val = parseInt(chip.dataset.value, 10);
    chip.disabled = val > remaining || state.phase !== 'betting';
  });
}

function renderReadyButton(state) {
  const me = myPlayer(state);
  const total = me ? me.totalBet : 0;
  const ready = me ? me.ready : false;
  els.readyBtn.disabled = total <= 0 || ready;
  els.readyBtn.textContent = ready ? 'En attente des autres…' : 'Je suis prêt';
  els.undoBetBtn.disabled = total <= 0;
  els.clearBetBtn.disabled = total <= 0;
}

function setStatus(message, kind = '') {
  if (els.statusMessage.textContent === message && els.statusMessage.className.includes(kind)) return;
  els.statusMessage.textContent = message;
  els.statusMessage.className = 'status-message';
  if (kind) els.statusMessage.classList.add(kind);
  void els.statusMessage.offsetWidth;
  els.statusMessage.classList.add('pop');
}

function tickBettingTimer() {
  if (!latestState || latestState.phase !== 'betting') {
    els.bettingTimer.hidden = true;
    return;
  }
  const remainingMs = latestState.bettingEndsAt - Date.now();
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  els.bettingTimer.hidden = false;
  els.bettingTimer.textContent = `Lancer dans ${seconds}s`;
  els.bettingTimer.classList.toggle('urgent', seconds <= 5);
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function sayDealer(text, duration = 2600) {
  clearTimeout(dealerCalloutTimer);
  els.dealerCallout.innerHTML = `<span>${text}</span>`;
  dealerCalloutTimer = setTimeout(() => { els.dealerCallout.innerHTML = ''; }, duration);
}

// ---------- Historique ----------
function renderHistoryIfChanged(list) {
  const sig = list.join(',');
  if (sig === lastHistorySignature) return;
  lastHistorySignature = sig;
  els.historyStrip.innerHTML = list.map((n) => {
    const c = numberColor(n);
    const cls = c === 'red' ? 'red-n' : c === 'black' ? 'black-n' : 'green-n';
    return `<span class="history-chip ${cls}">${n}</span>`;
  }).join('');
}

// ---------- Surlignage des résultats sur le tapis ----------
function clearBetHighlights() {
  els.board.querySelectorAll('[data-bet]').forEach((c) => {
    c.classList.remove('bet-win', 'bet-lose', 'winning-number');
  });
}

function onResolved(state, agg) {
  const n = state.winningNumber;
  agg.forEach((data, betId) => {
    const cell = cellFor(betId);
    if (!cell) return;
    cell.classList.add(betWins(betId, n) ? 'bet-win' : 'bet-lose');
  });
  const numberCell = cellFor(`straight-${n}`);
  if (numberCell) numberCell.classList.add('winning-number');

  const me = myPlayer(state);
  if (me && me.lastResult && me.lastResult.totalBet > 0) {
    const { winnings } = me.lastResult;
    if (winnings > 0) {
      showToast(`${n} — Vous gagnez ${winnings.toLocaleString('fr-FR')} jetons !`);
      Maison21Sound.win();
    } else {
      showToast(`${n} — Vous perdez ce tour`);
      Maison21Sound.lose();
    }
  }
}

// ---------- Rotation de la roue et de la bille (purement visuel, local) ----------
function spinWheelTo(number) {
  const idx = WHEEL_ORDER.indexOf(number);
  const pocketAngle = idx * POCKET_ANGLE;

  // Petites variations visuelles générées localement (pas besoin de
  // synchroniser l'angle exact entre clients, seul le numéro final compte).
  const wheelTurns = 4 + Math.floor(Math.random() * 3); // 4 à 6 tours
  const wheelExtra = Math.random() * 360;
  const newWheelRotation = wheelRotation + 360 * wheelTurns + wheelExtra;

  const targetAbsolute = (((newWheelRotation % 360) + pocketAngle) % 360 + 360) % 360;
  const currentBallMod = ((ballRotation % 360) + 360) % 360;
  const deltaToTarget = ((targetAbsolute - currentBallMod) % 360 + 360) % 360;
  const ballTurns = 6 + Math.floor(Math.random() * 3); // 6 à 8 tours
  const newBallRotation = ballRotation + 360 * ballTurns + deltaToTarget;

  wheelRotation = newWheelRotation;
  ballRotation = newBallRotation;

  els.wheel.style.transform = `rotate(${wheelRotation}deg)`;
  els.ballPivot.style.transform = `rotate(${ballRotation}deg)`;

  // Bille qui roule puis se pose : durée alignée sur la transition CSS de
  // la bille (4.6s, voir .ball-pivot dans style.css).
  const SPIN_DURATION_S = 4.6;
  Maison21Sound.ballRoll(SPIN_DURATION_S);
  setTimeout(() => Maison21Sound.ballLand(), SPIN_DURATION_S * 1000);
}

// ---------- Mises : envoi au serveur ----------
function placeBet(betId) {
  if (!latestState || latestState.phase !== 'betting') return;
  const me = myPlayer(latestState);
  const bankroll = me ? me.bankroll : loadCachedBankroll();
  const total = me ? me.totalBet : 0;
  const remaining = bankroll - total;
  if (selectedChip > remaining) {
    showToast('Fonds insuffisants pour ce jeton');
    return;
  }
  Maison21Sound.chip();
  send({ type: 'bet', betId, amount: selectedChip });
}

// ---------- Rendu global à partir d'un "state" serveur ----------
function render(state) {
  const previousPhase = lastPhase;
  latestState = state;

  els.playersCount.textContent = state.playersCount;

  const me = myPlayer(state);
  if (me) els.myNameLabel.textContent = me.name;
  const bankroll = me ? me.bankroll : loadCachedBankroll();
  updateBankrollDisplay(bankroll);
  cacheBankroll(bankroll);

  renderHistoryIfChanged(state.history);
  const agg = renderBoardBets(state);
  updateBetDisplay(state);
  updateChipAvailability(state);
  renderReadyButton(state);

  setStatus(state.statusMessage, state.statusKind);
  tickBettingTimer();

  const betting = state.phase === 'betting';
  els.betZone.hidden = !betting;
  els.board.classList.toggle('locked', !betting);

  const showGameActions = state.phase === 'spinning' || state.phase === 'resolved';
  els.gameActions.hidden = !showGameActions;
  if (state.phase === 'spinning') els.waitingNote.textContent = 'La bille tourne…';
  else if (state.phase === 'resolved') els.waitingNote.textContent = 'Nouvelle manche dans quelques instants…';

  // Transitions de phase : déclenche l'animation de la roue, nettoie ou
  // applique les surlignages, une seule fois par manche.
  if (state.phase === 'spinning' && previousPhase !== 'spinning') {
    spinWheelTo(state.winningNumber);
  }
  if (state.phase === 'betting' && previousPhase !== 'betting') {
    clearBetHighlights();
  }
  if (state.phase === 'resolved' && previousPhase !== 'resolved') {
    onResolved(state, agg);
  }
  lastPhase = state.phase;
}

// ---------- Connexion WebSocket ----------
let ws = null;
let reconnectDelay = 1000;
const RECONNECT_MAX = 10000;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Chemin de base = dossier de la page actuelle (enlève le nom de fichier
  // éventuel, ex. "index.html"). Permet au jeu de fonctionner aussi bien
  // servi à la racine du domaine que sous un sous-chemin comme /roulette/
  // derrière un reverse proxy (nginx) — le websocket reste toujours relatif.
  const basePath = location.pathname.replace(/[^/]*$/, '');
  return `${proto}//${location.host}${basePath}ws`;
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function connect() {
  setStatus('Connexion à la table…');
  els.connDot.classList.remove('online');

  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    els.connDot.classList.add('online');
    send({ type: 'hello', playerId: myPlayerId });
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === 'welcome') {
      cacheBankroll(msg.bankroll);
      els.myNameLabel.textContent = msg.name;
    } else if (msg.type === 'state') {
      render(msg);
    } else if (msg.type === 'dealerSay') {
      sayDealer(msg.text, msg.duration);
    } else if (msg.type === 'toast') {
      showToast(msg.text);
    } else if (msg.type === 'leaderboard') {
      renderLeaderboard(msg.entries);
    }
  });

  const onDown = () => {
    latestState = null; // évite d'afficher un minuteur/état périmé pendant la coupure
    lastPhase = null;    // resynchronisation propre des transitions à la reconnexion
    els.connDot.classList.remove('online');
    setStatus('Connexion perdue — reconnexion…');
    els.betZone.hidden = true;
    els.gameActions.hidden = true;
    els.bettingTimer.hidden = true;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, RECONNECT_MAX);
  };
  ws.addEventListener('close', onDown);
  ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
}

// ---------- Actions du joueur ----------
els.chipRack.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || chip.disabled) return;
  selectedChip = parseInt(chip.dataset.value, 10);
  els.chipRack.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
});
els.undoBetBtn.addEventListener('click', () => send({ type: 'undoBet' }));
els.clearBetBtn.addEventListener('click', () => send({ type: 'clearBets' }));
els.readyBtn.addEventListener('click', () => { if (!els.readyBtn.disabled) send({ type: 'ready' }); });

// ---------- Son ----------
document.addEventListener('click', () => Maison21Sound.primeAudio(), { once: true });

function updateSoundBtn() {
  const muted = Maison21Sound.isMuted();
  els.soundBtn.textContent = muted ? '🔇' : '🔊';
  els.soundBtn.title = muted ? 'Activer le son' : 'Couper le son';
}
els.soundBtn.addEventListener('click', () => { Maison21Sound.toggleMuted(); updateSoundBtn(); });
updateSoundBtn();

els.rulesBtn.addEventListener('click', () => els.rulesModal.classList.add('open'));
els.closeRulesBtn.addEventListener('click', () => els.rulesModal.classList.remove('open'));
els.rulesModal.addEventListener('click', (e) => {
  if (e.target === els.rulesModal) els.rulesModal.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    els.rulesModal.classList.remove('open');
    els.profileModal.classList.remove('open');
    if (els.leaderboardModal) els.leaderboardModal.classList.remove('open');
  }
});

// ---------- Classement (leaderboard) ----------
function renderLeaderboard(entries) {
  els.leaderboardList.innerHTML = '';
  if (!entries || entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'leaderboard-empty';
    empty.textContent = 'Aucun joueur enregistré pour le moment.';
    els.leaderboardList.appendChild(empty);
    return;
  }
  entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'leaderboard-row' + (entry.id === myPlayerId ? ' mine' : '');

    const rank = document.createElement('span');
    rank.className = 'leaderboard-rank';
    rank.textContent = `#${i + 1}`;

    const name = document.createElement('span');
    name.className = 'leaderboard-name';
    // Pseudo potentiellement personnalisé par un joueur : toujours en
    // textContent (jamais innerHTML), pour empêcher toute injection
    // HTML/JS (XSS).
    name.textContent = entry.name;

    const record = document.createElement('span');
    record.className = 'leaderboard-record';
    record.textContent = `${entry.record.toLocaleString('fr-FR')} jetons`;

    row.appendChild(rank);
    row.appendChild(name);
    row.appendChild(record);
    els.leaderboardList.appendChild(row);
  });
}

(function initLeaderboardModal() {
  if (!els.leaderboardBtn || !els.leaderboardModal) return;

  els.leaderboardBtn.addEventListener('click', () => {
    els.leaderboardList.innerHTML = '<p class="leaderboard-loading">Chargement du classement…</p>';
    els.leaderboardModal.classList.add('open');
    send({ type: 'getLeaderboard' });
  });
  els.closeLeaderboardBtn.addEventListener('click', () => els.leaderboardModal.classList.remove('open'));
  els.leaderboardModal.addEventListener('click', (e) => {
    if (e.target === els.leaderboardModal) els.leaderboardModal.classList.remove('open');
  });
})();

// ---------- Pseudo personnalisable ----------
(function initProfileModal() {
  function openModal() {
    const me = latestState ? myPlayer(latestState) : null;
    els.nameInput.value = me ? me.name : els.myNameLabel.textContent;
    els.profileModal.classList.add('open');
    els.nameInput.focus();
    els.nameInput.select();
  }
  function closeModal() { els.profileModal.classList.remove('open'); }
  function saveName() {
    const raw = els.nameInput.value.trim();
    if (raw) send({ type: 'setName', name: raw });
    closeModal();
  }

  els.profileBtn.addEventListener('click', openModal);
  els.closeProfileBtn.addEventListener('click', closeModal);
  els.profileModal.addEventListener('click', (e) => { if (e.target === els.profileModal) closeModal(); });
  els.saveNameBtn.addEventListener('click', saveName);
  els.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });
})();

// ---------- Menu inter-jeux ----------
// Petit panneau dupliqué à l'identique sur les 4 pages du site (lobby,
// blackjack, roulette, poker) pour changer de jeu en un clic, sans repasser
// par l'accueil. Pas de dépendance à un module JS partagé : logique simple
// et autonome, cohérente partout.
(function initGameMenu() {
  const btn = document.getElementById('gameMenuBtn');
  const panel = document.getElementById('gameMenuPanel');
  if (!btn || !panel) return;

  function closeMenu() {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.hidden) openMenu(); else closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
})();

// ---------- Compte utilisateur (connexion / inscription / déconnexion) ----------
// Système de comptes partagé sur tout le site (voir shared/auth-server.js) :
// un cookie de session HttpOnly (m21_session), posé avec Path=/ et sans
// Domain explicite, est automatiquement envoyé à toutes les pages du même
// domaine (lobby + 3 jeux, même sous des chemins différents) — un seul
// login vaut donc pour tout le site. Widget dupliqué à l'identique sur les
// 4 pages (même logique que le menu inter-jeux ci-dessus), sans dépendance
// à un module JS partagé entre pages.
(function initAuthWidget() {
  const pill = document.getElementById('authPill');
  const modal = document.getElementById('authModal');
  if (!pill || !modal) return;

  const pillIcon = document.getElementById('authPillIcon');
  const pillLabel = document.getElementById('authPillLabel');
  const closeBtn = document.getElementById('closeAuthBtn');
  const loggedInView = document.getElementById('authLoggedInView');
  const loggedOutView = document.getElementById('authLoggedOutView');
  const accountNameEl = document.getElementById('authAccountName');
  const logoutBtn = document.getElementById('authLogoutBtn');
  const tabLogin = document.getElementById('authTabLogin');
  const tabRegister = document.getElementById('authTabRegister');
  const loginForm = document.getElementById('authLoginForm');
  const registerForm = document.getElementById('authRegisterForm');
  const errorEl = document.getElementById('authError');

  let currentAccount = null; // pseudo du compte connecté, ou null si anonyme

  function setAuthError(message) {
    if (!message) { errorEl.hidden = true; errorEl.textContent = ''; return; }
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function updateAuthPill() {
    if (currentAccount) {
      pill.classList.add('connected');
      pillIcon.textContent = '👤';
      pillLabel.textContent = currentAccount;
      pill.title = `Connecté en tant que ${currentAccount} — cliquez pour gérer votre compte`;
    } else {
      pill.classList.remove('connected');
      pillIcon.textContent = '🔐';
      pillLabel.textContent = 'Se connecter';
      pill.title = 'Connexion / inscription';
    }
  }

  function showAuthTab(which) {
    const isLogin = which === 'login';
    tabLogin.classList.toggle('active', isLogin);
    tabRegister.classList.toggle('active', !isLogin);
    loginForm.hidden = !isLogin;
    registerForm.hidden = isLogin;
    setAuthError(null);
  }

  // Interroge le service d'auth pour savoir si un compte est déjà connecté
  // (cookie de session posé lors d'une visite précédente, éventuellement
  // depuis une autre page du site) : c'est la source de vérité pour cette
  // pastille, plus simple et cohérente sur les 4 pages qu'un état dérivé du
  // "welcome" websocket (voir aussi son champ "account", utilisé côté
  // serveur pour l'identité de jeu, mais pas repris ici pour ne pas avoir
  // deux sources d'affichage différentes).
  function refreshAuthFromServer() {
    return fetch('/auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { username: null }))
      .then((data) => {
        currentAccount = (data && data.username) || null;
        updateAuthPill();
      })
      .catch(() => { /* hors-ligne : on garde le dernier état affiché */ });
  }

  function openAuthModal() {
    setAuthError(null);
    if (currentAccount) {
      loggedInView.hidden = false;
      loggedOutView.hidden = true;
      accountNameEl.textContent = currentAccount;
    } else {
      loggedInView.hidden = true;
      loggedOutView.hidden = false;
      showAuthTab('login');
      loginForm.reset();
      registerForm.reset();
    }
    modal.classList.add('open');
  }
  function closeAuthModal() { modal.classList.remove('open'); }

  pill.addEventListener('click', openAuthModal);
  closeBtn.addEventListener('click', closeAuthModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeAuthModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAuthModal(); });

  tabLogin.addEventListener('click', () => showAuthTab('login'));
  tabRegister.addEventListener('click', () => showAuthTab('register'));

  async function postAuthJson(url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, data: { message: 'Connexion au serveur impossible.' } };
    }
    let data = null;
    try { data = await res.json(); } catch { /* réponse sans corps JSON */ }
    return { ok: res.ok, data };
  }

  // Après une connexion/inscription/déconnexion réussie DEPUIS un jeu, le
  // websocket de CE jeu doit se reconnecter pour relire le nouveau cookie
  // et basculer sur (ou quitter) l'identité du compte : un simple
  // rechargement de page fait ça proprement, sans logique de reconnexion
  // manuelle à dupliquer ici.
  function afterAuthChange() {
    location.reload();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthError(null);
    const username = document.getElementById('authLoginUsername').value;
    const password = document.getElementById('authLoginPassword').value;
    const submitBtn = loginForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const { ok, data } = await postAuthJson('/auth/login', { username, password });
    if (ok && data && data.ok) { afterAuthChange(); return; }
    submitBtn.disabled = false;
    setAuthError((data && data.message) || 'Connexion impossible.');
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthError(null);
    const username = document.getElementById('authRegisterUsername').value;
    const password = document.getElementById('authRegisterPassword').value;
    const submitBtn = registerForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const { ok, data } = await postAuthJson('/auth/register', { username, password });
    if (ok && data && data.ok) { afterAuthChange(); return; }
    submitBtn.disabled = false;
    setAuthError((data && data.message) || 'Impossible de créer ce compte.');
  });

  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* on recharge de toute façon, l'état repartira à jour */ }
    afterAuthChange();
  });

  refreshAuthFromServer();
})();

// ---------- Init ----------
function init() {
  buildBoard();
  buildWheel();
  els.bankroll.textContent = loadCachedBankroll().toLocaleString('fr-FR');
  els.betZone.hidden = true;
  els.gameActions.hidden = true;
  // Repositionne les points de mise une fois les polices/mise en page stabilisées.
  requestAnimationFrame(() => requestAnimationFrame(positionHotspots));
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(positionHotspots).catch(() => {});
  }
  bettingTickInterval = setInterval(tickBettingTimer, 500);
  connect();
}
init();
