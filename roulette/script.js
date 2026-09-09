'use strict';

/* ============================================================
   ROULETTE EUROPÉENNE — logique de jeu
   37 cases (0 à 36, zéro unique). Tirage cryptographiquement
   aléatoire via crypto.getRandomValues, comme au blackjack.
   Paiements : plein 35:1, chances simples 1:1, douzaines/
   colonnes 2:1. Le zéro fait perdre toutes les mises extérieures
   sauf s'il est misé en plein.
   ============================================================ */

// Ordre réel des cases sur une roue européenne (sens horaire).
const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const POCKET_COUNT = WHEEL_ORDER.length; // 37
const POCKET_ANGLE = 360 / POCKET_COUNT;

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const STORAGE_KEY = 'maison21_roulette_bankroll';
const START_BANKROLL = 1000;
const HISTORY_MAX = 10;

// ---------- State ----------
let bankroll = loadBankroll();
let bets = {};        // { betId: montant }
let betLog = [];       // pile des mises pour "Annuler"
let selectedChip = 5;
let state = 'betting'; // betting | spinning | result
let wheelRotation = 0; // rotation cumulée de la roue (deg)
let ballRotation = 0;  // rotation cumulée de la bille (deg)
let history = [];      // derniers numéros sortis
let dealerCalloutTimer = null;

// ---------- DOM refs ----------
const els = {
  bankroll: document.getElementById('bankroll'),
  bankrollPill: document.querySelector('.bankroll-pill'),
  betAmount: document.getElementById('betAmount'),
  chipRack: document.getElementById('chipRack'),
  undoBetBtn: document.getElementById('undoBetBtn'),
  clearBetBtn: document.getElementById('clearBetBtn'),
  spinBtn: document.getElementById('spinBtn'),
  betZone: document.getElementById('betZone'),
  gameActions: document.getElementById('gameActions'),
  nextRoundBtn: document.getElementById('nextRoundBtn'),
  board: document.getElementById('board'),
  statusMessage: document.getElementById('statusMessage'),
  toast: document.getElementById('toast'),
  rulesBtn: document.getElementById('rulesBtn'),
  closeRulesBtn: document.getElementById('closeRulesBtn'),
  rulesModal: document.getElementById('rulesModal'),
  dealerCallout: document.getElementById('dealerCallout'),
  wheel: document.getElementById('wheel'),
  ballPivot: document.getElementById('ballPivot'),
  historyStrip: document.getElementById('historyStrip'),
};

// ---------- Persistence ----------
function loadBankroll() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const n = saved !== null ? parseInt(saved, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : START_BANKROLL;
}
function saveBankroll() {
  localStorage.setItem(STORAGE_KEY, String(bankroll));
}

// ---------- Random source ----------
// Flottant [0,1) via crypto.getRandomValues (repli Math.random),
// même approche que le blackjack, pour un tirage fiable.
function secureRandom() {
  if (window.crypto && window.crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return buf[0] / 4294967296; // 2^32
  }
  return Math.random();
}
function secureRandomInt(maxExclusive) {
  return Math.floor(secureRandom() * maxExclusive);
}

// ---------- Numéro : couleur / parité / manque-passe ----------
function numberColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// ---------- Mises : définition des gains ----------
function betWins(betId, n) {
  if (betId.startsWith('straight-')) return parseInt(betId.slice(9), 10) === n;
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
function betMultiplier(betId) {
  if (betId.startsWith('straight-')) return 36; // 35:1 + mise rendue
  if (['dozen-1', 'dozen-2', 'dozen-3', 'col-1', 'col-2', 'col-3'].includes(betId)) return 3; // 2:1 + mise
  return 2; // chances simples 1:1 + mise
}

// ---------- Construction du tapis ----------
function buildBoard() {
  const boardNumbers = document.createElement('div');
  boardNumbers.className = 'board-numbers';

  const zero = makeCell('straight-0', '0', ['zero-cell']);
  boardNumbers.appendChild(zero);

  const grid = document.createElement('div');
  grid.className = 'number-grid';
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
  boardNumbers.appendChild(grid);

  const colBets = document.createElement('div');
  colBets.className = 'column-bets';
  colBets.appendChild(makeCell('col-3', '2:1'));
  colBets.appendChild(makeCell('col-2', '2:1'));
  colBets.appendChild(makeCell('col-1', '2:1'));
  boardNumbers.appendChild(colBets);

  els.board.appendChild(boardNumbers);

  const dozensRow = document.createElement('div');
  dozensRow.className = 'dozens-row';
  dozensRow.appendChild(makeCell('dozen-1', '1er 12'));
  dozensRow.appendChild(makeCell('dozen-2', '2e 12'));
  dozensRow.appendChild(makeCell('dozen-3', '3e 12'));
  els.board.appendChild(dozensRow);

  const outsideRow = document.createElement('div');
  outsideRow.className = 'outside-row';
  outsideRow.appendChild(makeCell('low', '1-18'));
  outsideRow.appendChild(makeCell('even', 'PAIR'));
  outsideRow.appendChild(makeCell('red', 'ROUGE', ['outside-red']));
  outsideRow.appendChild(makeCell('black', 'NOIR', ['outside-black']));
  outsideRow.appendChild(makeCell('odd', 'IMPAIR'));
  outsideRow.appendChild(makeCell('high', '19-36'));
  els.board.appendChild(outsideRow);
}

function makeCell(betId, label, extraClasses = []) {
  const cell = document.createElement('div');
  cell.className = ['cell', ...extraClasses].join(' ');
  cell.dataset.bet = betId;
  cell.innerHTML = `<span class="cell-label">${label}</span><span class="bet-badge"></span>`;
  cell.addEventListener('click', () => placeBet(betId));
  return cell;
}

function cellFor(betId) {
  return els.board.querySelector(`.cell[data-bet="${betId}"]`);
}

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

  // Fond conique décoratif (secteurs colorés) aligné sur les cases.
  const seg = 100 / POCKET_COUNT;
  const half = seg / 2;
  const stops = [];
  for (let i = 0; i < POCKET_COUNT; i++) {
    const n = WHEEL_ORDER[i];
    const color = numberColor(n);
    const c = color === 'red' ? '#a8322a' : color === 'black' ? '#1a1a1a' : '#0e4530';
    const start = (i * seg - half + 100) % 100;
    stops.push(`${c} ${i === 0 ? 0 : start}% ${(start + seg).toFixed(3)}%`);
  }
  els.wheel.style.background = `conic-gradient(from ${-half}deg, ${stops.join(', ')})`;
}

// ---------- Rendu / UI ----------
function totalBet() {
  return Object.values(bets).reduce((a, b) => a + b, 0);
}

function updateBankrollDisplay(animate = true) {
  els.bankroll.textContent = bankroll.toLocaleString('fr-FR');
  if (animate) {
    els.bankrollPill.classList.remove('bump');
    void els.bankrollPill.offsetWidth;
    els.bankrollPill.classList.add('bump');
  }
}

function updateBetDisplay() {
  const total = totalBet();
  els.betAmount.textContent = total.toLocaleString('fr-FR');
  els.spinBtn.disabled = total <= 0 || state !== 'betting';
  els.undoBetBtn.disabled = betLog.length === 0;
  els.clearBetBtn.disabled = total <= 0;
}

function updateChipAvailability() {
  const remaining = bankroll - totalBet();
  els.chipRack.querySelectorAll('.chip').forEach((chip) => {
    const val = parseInt(chip.dataset.value, 10);
    chip.disabled = val > remaining || state !== 'betting';
  });
}

function refreshBadge(betId) {
  const cell = cellFor(betId);
  if (!cell) return;
  const badge = cell.querySelector('.bet-badge');
  const amount = bets[betId] || 0;
  if (amount > 0) {
    badge.textContent = amount >= 1000 ? `${(amount / 1000).toFixed(1)}k` : amount;
    badge.classList.add('show');
  } else {
    badge.textContent = '';
    badge.classList.remove('show');
  }
}

function setStatus(message, kind = '') {
  els.statusMessage.textContent = message;
  els.statusMessage.className = 'status-message';
  if (kind) els.statusMessage.classList.add(kind);
  void els.statusMessage.offsetWidth;
  els.statusMessage.classList.add('pop');
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
  dealerCalloutTimer = setTimeout(() => {
    els.dealerCallout.innerHTML = '';
  }, duration);
}

// ---------- Historique ----------
function pushHistory(n) {
  history.unshift(n);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  renderHistory();
}
function renderHistory() {
  els.historyStrip.innerHTML = history
    .map((n) => {
      const c = numberColor(n);
      const cls = c === 'red' ? 'red-n' : c === 'black' ? 'black-n' : 'green-n';
      return `<span class="history-chip ${cls}">${n}</span>`;
    })
    .join('');
}

// ---------- Mises ----------
function placeBet(betId) {
  if (state !== 'betting') return;
  const remaining = bankroll - totalBet();
  if (selectedChip > remaining) {
    showToast('Fonds insuffisants pour ce jeton');
    return;
  }
  bets[betId] = (bets[betId] || 0) + selectedChip;
  betLog.push({ betId, value: selectedChip });
  refreshBadge(betId);
  updateBetDisplay();
  updateChipAvailability();
}

function undoBet() {
  if (state !== 'betting' || betLog.length === 0) return;
  const last = betLog.pop();
  bets[last.betId] -= last.value;
  if (bets[last.betId] <= 0) delete bets[last.betId];
  refreshBadge(last.betId);
  updateBetDisplay();
  updateChipAvailability();
}

function clearBets() {
  if (state !== 'betting') return;
  const ids = Object.keys(bets);
  bets = {};
  betLog = [];
  ids.forEach(refreshBadge);
  updateBetDisplay();
  updateChipAvailability();
}

function clearBetHighlights() {
  els.board.querySelectorAll('.cell').forEach((c) => {
    c.classList.remove('bet-win', 'bet-lose', 'winning-number');
  });
}

// ---------- Annonce du croupier ----------
function announceResult(n) {
  const color = numberColor(n);
  if (n === 0) return '0, zéro.';
  const colorFr = color === 'red' ? 'rouge' : 'noir';
  const parity = n % 2 === 0 ? 'pair' : 'impair';
  const range = n <= 18 ? 'manque' : 'passe';
  return `${n}, ${colorFr}, ${parity}, ${range}.`;
}

// ---------- Rotation de la roue et de la bille ----------
function spinWheelTo(number) {
  const idx = WHEEL_ORDER.indexOf(number);
  const pocketAngle = idx * POCKET_ANGLE;

  const wheelTurns = 4 + secureRandomInt(3); // 4 à 6 tours
  const wheelExtra = secureRandom() * 360;
  const newWheelRotation = wheelRotation + 360 * wheelTurns + wheelExtra;

  // La bille doit finir exactement au-dessus de la case gagnante,
  // qui se trouve désormais à l'angle absolu (rotation roue + angle case).
  const targetAbsolute = (((newWheelRotation % 360) + pocketAngle) % 360 + 360) % 360;
  const currentBallMod = ((ballRotation % 360) + 360) % 360;
  const deltaToTarget = ((targetAbsolute - currentBallMod) % 360 + 360) % 360;
  const ballTurns = 6 + secureRandomInt(3); // 6 à 8 tours, sens opposé visuellement plus rapide
  const newBallRotation = ballRotation + 360 * ballTurns + deltaToTarget;

  wheelRotation = newWheelRotation;
  ballRotation = newBallRotation;

  els.wheel.style.transform = `rotate(${wheelRotation}deg)`;
  els.ballPivot.style.transform = `rotate(${ballRotation}deg)`;
}

// ---------- Cycle de jeu ----------
function spin() {
  if (state !== 'betting') return;
  const total = totalBet();
  if (total <= 0 || total > bankroll) return;

  state = 'spinning';
  bankroll -= total;
  updateBankrollDisplay();
  saveBankroll();
  updateBetDisplay();
  updateChipAvailability();
  els.board.classList.add('locked');

  setStatus('La bille tourne…');
  sayDealer('Les jeux sont faits, rien ne va plus.', 3200);

  const winningNumber = secureRandomInt(POCKET_COUNT);
  spinWheelTo(winningNumber);

  const SPIN_DURATION = 4600;
  setTimeout(() => resolveSpin(winningNumber), SPIN_DURATION);
}

function resolveSpin(n) {
  state = 'result';

  let winnings = 0;
  for (const [betId, amount] of Object.entries(bets)) {
    const cell = cellFor(betId);
    if (betWins(betId, n)) {
      winnings += amount * betMultiplier(betId);
      if (cell) cell.classList.add('bet-win');
    } else if (cell) {
      cell.classList.add('bet-lose');
    }
  }

  bankroll += winnings;
  updateBankrollDisplay();
  saveBankroll();

  const numberCell = cellFor(`straight-${n}`);
  if (numberCell) numberCell.classList.add('winning-number');

  pushHistory(n);

  const color = numberColor(n);
  const kindClass = winnings > totalBet() ? 'win' : winnings > 0 ? 'push' : winnings === 0 && totalBet() === 0 ? '' : 'lose';
  const colorLabel = color === 'red' ? 'Rouge' : color === 'black' ? 'Noir' : 'Zéro';
  let message;
  if (winnings > 0) {
    message = `${n} · ${colorLabel} — Vous gagnez ${winnings.toLocaleString('fr-FR')} jetons !`;
  } else {
    message = `${n} · ${colorLabel} — Vous perdez ce tour`;
  }
  setStatus(message, winnings > 0 ? 'win' : 'lose');
  sayDealer(announceResult(n), 3200);

  els.betZone.style.display = 'none';
  els.gameActions.hidden = false;

  if (bankroll <= 0) {
    setTimeout(() => {
      showToast('Plus de jetons — remise à zéro du solde');
      bankroll = START_BANKROLL;
      updateBankrollDisplay();
      saveBankroll();
    }, 1400);
  }
}

function nextRound() {
  state = 'betting';
  const ids = Object.keys(bets);
  bets = {};
  betLog = [];
  ids.forEach(refreshBadge);
  clearBetHighlights();
  els.board.classList.remove('locked');
  updateBetDisplay();
  updateChipAvailability();

  els.gameActions.hidden = true;
  els.betZone.style.display = 'flex';
  setStatus('Placez vos mises');
  sayDealer('Faites vos jeux, mesdames et messieurs.');
}

// ---------- Event bindings ----------
els.chipRack.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || chip.disabled) return;
  selectedChip = parseInt(chip.dataset.value, 10);
  els.chipRack.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
});
els.undoBetBtn.addEventListener('click', undoBet);
els.clearBetBtn.addEventListener('click', clearBets);
els.spinBtn.addEventListener('click', spin);
els.nextRoundBtn.addEventListener('click', nextRound);

els.rulesBtn.addEventListener('click', () => els.rulesModal.classList.add('open'));
els.closeRulesBtn.addEventListener('click', () => els.rulesModal.classList.remove('open'));
els.rulesModal.addEventListener('click', (e) => {
  if (e.target === els.rulesModal) els.rulesModal.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') els.rulesModal.classList.remove('open');
});

// ---------- Init ----------
function init() {
  buildBoard();
  buildWheel();
  updateBankrollDisplay(false);
  updateBetDisplay();
  updateChipAvailability();
  els.gameActions.hidden = true;
  sayDealer('Bienvenue à la table ! Faites vos jeux.');
}
init();
