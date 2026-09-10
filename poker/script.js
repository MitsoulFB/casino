'use strict';

/* ============================================================
   POKER TEXAS HOLD'EM — Maison21
   Un joueur humain contre 4 adversaires IA avec personnalité.
   Moteur complet : mises, relances, blinds tournantes, pots
   annexes (side pots), évaluateur de mains 7 cartes -> meilleure
   combinaison de 5, ambiance RP en français.
   ============================================================ */

const SUITS = [
  { key: 'spades',   symbol: '♠', color: 'black' },
  { key: 'hearts',   symbol: '♥', color: 'red' },
  { key: 'diamonds', symbol: '♦', color: 'red' },
  { key: 'clubs',    symbol: '♣', color: 'black' },
];
const RANKS = [
  { rank: '2', value: 2 }, { rank: '3', value: 3 }, { rank: '4', value: 4 },
  { rank: '5', value: 5 }, { rank: '6', value: 6 }, { rank: '7', value: 7 },
  { rank: '8', value: 8 }, { rank: '9', value: 9 }, { rank: '10', value: 10 },
  { rank: 'J', value: 11 }, { rank: 'Q', value: 12 }, { rank: 'K', value: 13 },
  { rank: 'A', value: 14 },
];

const STORAGE_KEY = 'maison21_poker_bankroll';
const START_BANKROLL = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const AI_START_STACK = 1000;

const HAND_LABELS = [
  'Carte haute', 'Paire', 'Double paire', 'Brelan', 'Suite',
  'Couleur', 'Full', 'Carré', 'Quinte flush',
];

// ---------- Personnalités des adversaires IA ----------
const PERSONALITIES = [
  {
    id: 'requin',
    name: 'Marcus « Le Requin »',
    tag: 'Bluffeur agressif',
    avatar: '🦈',
    aggression: 0.85,
    bluffFreq: 0.28,
    variance: 0.22,
    betThreshold: 0.42,
    foldThreshold: 0.22,
    raiseThreshold: 0.55,
    lines: {
      bet: ['Je pousse tout ça au centre.', 'Osez me suivre.', 'Ça va faire mal.'],
      raise: ['Je relance sévère.', 'Trop facile, je monte.', 'Tremblez.'],
      call: ['Je suis, pour voir.', 'Ça m\'amuse.'],
      check: ['Parole… pour l\'instant.'],
      fold: ['Bah, une autre fois.', 'Je garde mes crocs pour la prochaine.'],
      allin: ['TAPIS. Que le meilleur gagne.', 'Tout ou rien, comme toujours.'],
      win: ['Le requin a encore faim !', 'C\'était couru d\'avance.'],
    },
  },
  {
    id: 'roc',
    name: 'Tonton Roc',
    tag: 'Joueur prudent',
    avatar: '🗿',
    aggression: 0.28,
    bluffFreq: 0.04,
    variance: 0.06,
    betThreshold: 0.62,
    foldThreshold: 0.4,
    raiseThreshold: 0.75,
    lines: {
      bet: ['Une mise raisonnable.', 'Je mise ce qu\'il faut.'],
      raise: ['J\'ai de quoi relancer, croyez-moi.', 'Petite relance calculée.'],
      call: ['Je paie pour voir.', 'Ça reste correct.'],
      check: ['Parole. Pas besoin de se précipiter.'],
      fold: ['Trop risqué pour moi.', 'Je me couche, sagesse oblige.'],
      allin: ['Rare que je fasse ça… tapis.', 'J\'y vais, exceptionnellement.'],
      win: ['La patience paie toujours.', 'Doucement mais sûrement.'],
    },
  },
  {
    id: 'chaos',
    name: 'Jojo Chaos',
    tag: 'Joueur imprévisible',
    avatar: '🃏',
    aggression: 0.6,
    bluffFreq: 0.35,
    variance: 0.4,
    betThreshold: 0.35,
    foldThreshold: 0.15,
    raiseThreshold: 0.45,
    lines: {
      bet: ['Hop, jetons dans le pot !', 'Pourquoi pas ?', 'Ça me dit de miser.'],
      raise: ['Je relance juste pour le fun.', 'Allez, ça pique !'],
      call: ['Je suis, va savoir pourquoi.', 'Tiens, je paie.'],
      check: ['Parole, j\'ai la flemme.'],
      fold: ['Meh, je me couche.', 'J\'ai perdu le fil de toute façon.'],
      allin: ['TAPIS ! Aucune idée si c\'est malin.', 'Tout dedans, YOLO.'],
      win: ['Ahah, même moi je suis surpris !', 'Le chaos paie parfois !'],
    },
  },
  {
    id: 'pro',
    name: 'Vivian « La Pro »',
    tag: 'Joueuse calculatrice',
    avatar: '🎯',
    aggression: 0.55,
    bluffFreq: 0.14,
    variance: 0.1,
    betThreshold: 0.52,
    foldThreshold: 0.32,
    raiseThreshold: 0.63,
    lines: {
      bet: ['Mise standard, cotes correctes.', 'Je mise selon le pot.'],
      raise: ['Relance value, rien de plus.', 'Mathématiquement, je relance.'],
      call: ['Les cotes justifient l\'appel.', 'Je paie, c\'est rentable.'],
      check: ['Parole, je garde l\'info.'],
      fold: ['Les probabilités ne sont pas de mon côté.', 'Je laisse filer celle-ci.'],
      allin: ['Tapis — l\'espérance est favorable.', 'Calcul fait : tapis.'],
      win: ['L\'analyse était bonne.', 'Comme prévu.'],
    },
  },
];

// Répliques du croupier (ambiance RP, même style que le Blackjack)
const DEALER_LINES = {
  newHand: ['Nouvelle donne, mesdames et messieurs.', 'On rebat les cartes.'],
  preflop: ['Les paris sont ouverts.', 'À vous de jouer.'],
  flop: ['Le flop.'],
  turn: ['Le turn.'],
  river: ['La rivière.'],
  showdown: ['Les jeux sont faits.', 'Abattage des cartes.'],
  foldWin: ['La table s\'incline, un seul joueur reste en lice.'],
};

// ---------- État du jeu ----------
let deck = [];
let players = []; // index 0 = humain
let community = [];
let dealerIndex = 0;
let street = 'idle'; // idle | preflop | flop | turn | river | showdown
let currentStreetBet = 0;
let lastRaiseSize = BIG_BLIND;
let turnIndex = -1;
let needsAct = [];
let handInProgress = false;
let awaitingHumanAction = false;
let dealerCalloutTimer = null;

// ---------- DOM refs ----------
const els = {
  bankroll: document.getElementById('bankroll'),
  bankrollPill: document.querySelector('.bankroll-pill'),
  rulesBtn: document.getElementById('rulesBtn'),
  closeRulesBtn: document.getElementById('closeRulesBtn'),
  rulesModal: document.getElementById('rulesModal'),
  rebuyModal: document.getElementById('rebuyModal'),
  rebuyBtn: document.getElementById('rebuyBtn'),
  handSubText: document.getElementById('handSubText'),
  aiRow: document.getElementById('aiRow'),
  communityCards: document.getElementById('communityCards'),
  potAmount: document.getElementById('potAmount'),
  dealerCallout: document.getElementById('dealerCallout'),
  statusMessage: document.getElementById('statusMessage'),
  playerCards: document.getElementById('playerCards'),
  playerBestHand: document.getElementById('playerBestHand'),
  playerDealerTag: document.getElementById('playerDealerTag'),
  playerStackDisplay: document.getElementById('playerStackDisplay'),
  playerBetDisplay: document.getElementById('playerBetDisplay'),
  gameActions: document.getElementById('gameActions'),
  foldBtn: document.getElementById('foldBtn'),
  checkCallBtn: document.getElementById('checkCallBtn'),
  raiseBtn: document.getElementById('raiseBtn'),
  raiseZone: document.getElementById('raiseZone'),
  raiseSlider: document.getElementById('raiseSlider'),
  raiseAmountDisplay: document.getElementById('raiseAmountDisplay'),
  presetHalfPot: document.getElementById('presetHalfPot'),
  presetPot: document.getElementById('presetPot'),
  presetAllin: document.getElementById('presetAllin'),
  confirmRaiseBtn: document.getElementById('confirmRaiseBtn'),
  cancelRaiseBtn: document.getElementById('cancelRaiseBtn'),
  startZone: document.getElementById('startZone'),
  startHandBtn: document.getElementById('startHandBtn'),
  toast: document.getElementById('toast'),
};

// ---------- Persistance ----------
function loadBankroll() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const n = saved !== null ? parseInt(saved, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : START_BANKROLL;
}
function saveBankroll() {
  localStorage.setItem(STORAGE_KEY, String(players[0].stack));
}

// ---------- Random ----------
function secureRandom() {
  if (window.crypto && window.crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  }
  return Math.random();
}
function secureRandomInt(maxExclusive) { return Math.floor(secureRandom() * maxExclusive); }

// ---------- Deck ----------
function buildDeck() {
  const d = [];
  for (const suit of SUITS) {
    for (const r of RANKS) {
      d.push({ rank: r.rank, value: r.value, suit: suit.key, symbol: suit.symbol, color: suit.color });
    }
  }
  return d;
}
function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function drawCard() { return deck.pop(); }

// ============================================================
// ÉVALUATEUR DE MAINS (7 cartes -> meilleure combinaison de 5)
// ============================================================
function combinations5(cards) {
  // Génère toutes les combinaisons de 5 cartes parmi `cards` (<=7)
  const result = [];
  const n = cards.length;
  const idx = [0, 1, 2, 3, 4];
  if (n <= 5) { result.push(cards.slice()); return result; }
  const pick = (start, combo) => {
    if (combo.length === 5) { result.push(combo.slice()); return; }
    for (let i = start; i < n; i++) {
      combo.push(cards[i]);
      pick(i + 1, combo);
      combo.pop();
    }
  };
  pick(0, []);
  return result;
}

function evaluate5(cards) {
  // cards: 5 objets {rank,value,suit,...}
  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const isFlush = cards.every(c => c.suit === cards[0].suit);

  // Détection de suite (gère aussi la quinte basse A-2-3-4-5)
  const uniqueVals = [...new Set(values)];
  let straightHigh = null;
  if (uniqueVals.length === 5) {
    if (uniqueVals[0] - uniqueVals[4] === 4) straightHigh = uniqueVals[0];
    else if (uniqueVals.join(',') === '14,5,4,3,2') straightHigh = 5; // roue A-5
  }

  // Groupes par valeur (paires, brelans, carrés)
  const countMap = {};
  for (const v of values) countMap[v] = (countMap[v] || 0) + 1;
  const groups = Object.entries(countMap)
    .map(([v, c]) => ({ value: parseInt(v, 10), count: c }))
    .sort((a, b) => (b.count - a.count) || (b.value - a.value));

  const kickersFlat = () => groups.flatMap(g => Array(g.count).fill(g.value));

  if (straightHigh && isFlush) return { category: 8, tiebreak: [straightHigh], label: straightHigh === 14 ? 'Quinte flush royale' : 'Quinte flush' };
  if (groups[0].count === 4) return { category: 7, tiebreak: [groups[0].value, groups[1].value], label: HAND_LABELS[7] };
  if (groups[0].count === 3 && groups[1] && groups[1].count === 2) return { category: 6, tiebreak: [groups[0].value, groups[1].value], label: HAND_LABELS[6] };
  if (isFlush) return { category: 5, tiebreak: values, label: HAND_LABELS[5] };
  if (straightHigh) return { category: 4, tiebreak: [straightHigh], label: HAND_LABELS[4] };
  if (groups[0].count === 3) return { category: 3, tiebreak: kickersFlat(), label: HAND_LABELS[3] };
  if (groups[0].count === 2 && groups[1] && groups[1].count === 2) return { category: 2, tiebreak: kickersFlat(), label: HAND_LABELS[2] };
  if (groups[0].count === 2) return { category: 1, tiebreak: kickersFlat(), label: HAND_LABELS[1] };
  return { category: 0, tiebreak: values, label: HAND_LABELS[0] };
}

function compareEval(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] || 0;
    const bv = b.tiebreak[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function evaluateBest(cards7) {
  const combos = combinations5(cards7);
  let best = null;
  for (const combo of combos) {
    const ev = evaluate5(combo);
    if (!best || compareEval(ev, best) > 0) best = ev;
  }
  return best;
}

// ============================================================
// GESTION DES JOUEURS
// ============================================================
function initPlayers() {
  players = [];
  players.push({
    id: 0, isHuman: true, name: 'Vous', avatar: '🧑', tag: 'Vous',
    stack: loadBankroll(), hand: [], folded: false, allIn: false,
    streetBet: 0, totalContributed: 0, hasActedThisStreet: false,
  });
  PERSONALITIES.forEach((p, i) => {
    players.push({
      id: i + 1, isHuman: false, name: p.name, avatar: p.avatar, tag: p.tag, personality: p,
      stack: AI_START_STACK, hand: [], folded: false, allIn: false,
      streetBet: 0, totalContributed: 0, hasActedThisStreet: false,
    });
  });
  buildAiSeatsDOM();
}

function buildAiSeatsDOM() {
  els.aiRow.innerHTML = '';
  players.forEach((p, i) => {
    if (p.isHuman) return;
    const seat = document.createElement('div');
    seat.className = 'ai-seat';
    seat.id = `seat-${i}`;
    seat.innerHTML = `
      <div class="ai-callout" id="callout-${i}"></div>
      <div class="ai-seat-head">
        <div class="ai-avatar">${p.avatar}</div>
        <div class="ai-badges" id="badges-${i}"></div>
      </div>
      <div class="ai-name">${p.name}</div>
      <div class="ai-tag">${p.tag}</div>
      <div class="ai-cards" id="cards-${i}"></div>
      <div class="ai-stack-row">
        <span class="ai-stack" id="stack-${i}">${p.stack}</span>
        <span class="ai-bet" id="bet-${i}"></span>
      </div>`;
    els.aiRow.appendChild(seat);
  });
}

// ============================================================
// RENDU DES CARTES (identique dans l'esprit au Blackjack)
// ============================================================
function renderCardFace(card) {
  const isRed = card.color === 'red';
  return `
    <div class="card-face card-front${isRed ? ' red' : ''}">
      <div class="card-rank-top"><span>${card.rank}</span><span class="card-suit-small">${card.symbol}</span></div>
      <div class="card-suit-center">${card.symbol}</div>
      <div class="card-rank-bottom"><span>${card.rank}</span><span class="card-suit-small">${card.symbol}</span></div>
    </div>`;
}
function createCardSlot(card, faceDown = false) {
  const slot = document.createElement('div');
  slot.className = 'card-slot';
  slot.innerHTML = `<div class="card-inner">${renderCardFace(card)}<div class="card-face card-back"></div></div>`;
  if (faceDown) slot.classList.add('flipped');
  return slot;
}
function flipSlot(slot) { slot.classList.remove('flipped'); }

// ============================================================
// AFFICHAGE / UI
// ============================================================
function updateBankrollDisplay() {
  els.bankroll.textContent = players[0].stack.toLocaleString('fr-FR');
  els.bankrollPill.classList.remove('bump');
  void els.bankrollPill.offsetWidth;
  els.bankrollPill.classList.add('bump');
}

function potTotal() {
  return players.reduce((sum, p) => sum + p.totalContributed, 0);
}
function updatePotDisplay() {
  els.potAmount.textContent = potTotal().toLocaleString('fr-FR');
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

function sayDealer(text) {
  clearTimeout(dealerCalloutTimer);
  els.dealerCallout.innerHTML = `<span>${text}</span>`;
  dealerCalloutTimer = setTimeout(() => { els.dealerCallout.innerHTML = ''; }, 2400);
}
function pickLine(arr) { return arr[secureRandomInt(arr.length)]; }

function sayAi(i, category) {
  const p = players[i];
  if (!p || p.isHuman || !p.personality) return;
  const lines = p.personality.lines[category];
  if (!lines) return;
  const el = document.getElementById(`callout-${i}`);
  if (!el) return;
  el.innerHTML = `<span>${pickLine(lines)}</span>`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.innerHTML = ''; }, 2400);
}

function renderSeatBadges(i) {
  const p = players[i];
  const badgesEl = document.getElementById(`badges-${i}`);
  if (!badgesEl) return;
  const badges = [];
  if (dealerIndex === i) badges.push('<span class="seat-badge d">D</span>');
  if (sbIndex() === i) badges.push('<span class="seat-badge sb">SB</span>');
  if (bbIndex() === i) badges.push('<span class="seat-badge bb">BB</span>');
  if (p.allIn) badges.push('<span class="seat-badge allin" title="Tapis (all-in)">🂠</span>');
  badgesEl.innerHTML = badges.join('');
}

function renderPlayerBadge() {
  const badges = [];
  if (dealerIndex === 0) badges.push('D');
  else if (sbIndex() === 0) badges.push('SB');
  else if (bbIndex() === 0) badges.push('BB');
  els.playerDealerTag.textContent = badges.join(' ');
}

function renderAiSeat(i, { revealCards = false } = {}) {
  const p = players[i];
  const seatEl = document.getElementById(`seat-${i}`);
  if (!seatEl) return;
  seatEl.classList.toggle('folded', p.folded);
  seatEl.classList.toggle('active-turn', turnIndex === i && handInProgress);
  document.getElementById(`stack-${i}`).textContent = p.stack.toLocaleString('fr-FR');
  const betEl = document.getElementById(`bet-${i}`);
  betEl.textContent = p.streetBet > 0 ? p.streetBet.toLocaleString('fr-FR') : '';
  renderSeatBadges(i);

  const cardsEl = document.getElementById(`cards-${i}`);
  if (p.hand.length === 0) { cardsEl.innerHTML = ''; return; }
  if (p.folded && !revealCards) { cardsEl.innerHTML = ''; return; }
  if (cardsEl.children.length === 0) {
    p.hand.forEach(card => cardsEl.appendChild(createCardSlot(card, !revealCards)));
  }
  if (revealCards) {
    [...cardsEl.children].forEach(slot => flipSlot(slot));
  }
}

function renderAllSeats(opts = {}) {
  players.forEach((p, i) => { if (!p.isHuman) renderAiSeat(i, opts); });
  els.playerStackDisplay.textContent = players[0].stack.toLocaleString('fr-FR');
  els.playerBetDisplay.textContent = players[0].streetBet > 0 ? players[0].streetBet.toLocaleString('fr-FR') : '';
  renderPlayerBadge();
  updatePotDisplay();
}

function renderPlayerBestHand() {
  if (players[0].hand.length < 2 || players[0].folded) { els.playerBestHand.textContent = ''; return; }
  if (community.length === 0) { els.playerBestHand.textContent = ''; return; }
  const best = evaluateBest([...players[0].hand, ...community]);
  els.playerBestHand.textContent = best.label;
}

// ============================================================
// POSITIONS (bouton donneur, blinds)
// ============================================================
function nextActiveIndex(from, opts = {}) {
  // Prochain joueur encore en jeu (pas couché), en excluant les all-in si demandé
  const excludeAllIn = opts.excludeAllIn !== false;
  let i = from;
  for (let step = 0; step < players.length; step++) {
    i = (i + 1) % players.length;
    const p = players[i];
    if (p.folded) continue;
    if (excludeAllIn && p.allIn) continue;
    return i;
  }
  return -1;
}
function sbIndex() { return activeCountAtStart >= 2 ? nextIndexAny(dealerIndex) : -1; }
function bbIndex() { return activeCountAtStart >= 2 ? nextIndexAny(nextIndexAny(dealerIndex)) : -1; }
function nextIndexAny(from) {
  // Prochain siège (occupé) en ignorant simplement l'ordre circulaire — tous les joueurs
  // sont toujours "à table" dans cette implémentation (rachat automatique).
  return (from + 1) % players.length;
}
let activeCountAtStart = 5;

// ============================================================
// DÉMARRAGE D'UNE MAIN
// ============================================================
function startNewHand() {
  if (players[0].stack <= 0) { openRebuyModal(); return; }

  handInProgress = true;
  els.startZone.hidden = true;
  els.gameActions.hidden = true;
  els.raiseZone.hidden = true;

  // Rachat automatique des IA tombées à 0 pour garder la table pleine
  players.forEach(p => { if (!p.isHuman && p.stack <= 0) p.stack = AI_START_STACK; });

  // Réinitialisation de la main
  community = [];
  els.communityCards.innerHTML = '';
  players.forEach(p => {
    p.hand = []; p.folded = false; p.allIn = false;
    p.streetBet = 0; p.totalContributed = 0; p.hasActedThisStreet = false;
  });
  players.forEach((p, i) => {
    const cardsEl = document.getElementById(`cards-${i}`);
    if (cardsEl) cardsEl.innerHTML = '';
  });
  els.playerCards.innerHTML = '';
  els.playerBestHand.textContent = '';

  deck = shuffle(buildDeck());
  dealerIndex = (dealerIndex + 1) % players.length;
  activeCountAtStart = players.length;

  sayDealer(pickLine(DEALER_LINES.newHand));
  setStatus('Nouvelle main');

  // Poster les blinds
  const sb = sbIndex(), bb = bbIndex();
  postBlind(sb, SMALL_BLIND);
  postBlind(bb, BIG_BLIND);
  currentStreetBet = BIG_BLIND;
  lastRaiseSize = BIG_BLIND;

  renderAllSeats();
  els.handSubText.textContent = `Blinds ${SMALL_BLIND} / ${BIG_BLIND} · Bouton : ${players[dealerIndex].name}`;

  // Distribution des cartes (2 par joueur, animation en cascade)
  let dealDelay = 0;
  const dealSteps = [];
  for (let round = 0; round < 2; round++) {
    for (let k = 0; k < players.length; k++) {
      dealSteps.push(k);
    }
  }
  dealSteps.forEach((pi) => {
    setTimeout(() => dealCardToPlayer(pi), dealDelay);
    dealDelay += 90;
  });

  setTimeout(() => {
    street = 'preflop';
    turnIndex = nextActiveIndex(bb, { excludeAllIn: true }); // UTG = après la BB
    if (turnIndex === -1) turnIndex = nextActiveIndex(dealerIndex, { excludeAllIn: true });
    setupStreetNeedsAct({ preservePosted: true });
    sayDealer(pickLine(DEALER_LINES.preflop));
    processTurn();
  }, dealDelay + 250);
}

function postBlind(i, amount) {
  const p = players[i];
  const actual = Math.min(amount, p.stack);
  p.stack -= actual;
  p.streetBet += actual;
  p.totalContributed += actual;
  if (p.stack === 0) p.allIn = true;
}

function dealCardToPlayer(i) {
  const p = players[i];
  const card = drawCard();
  p.hand.push(card);
  if (p.isHuman) {
    const slot = createCardSlot(card, false);
    els.playerCards.appendChild(slot);
  } else {
    const cardsEl = document.getElementById(`cards-${i}`);
    if (cardsEl) cardsEl.appendChild(createCardSlot(card, true));
  }
}

// ============================================================
// MOTEUR DE MISES
// ============================================================
function activeNonFolded() { return players.filter(p => !p.folded); }
function activeDecisionMakers() { return players.filter(p => !p.folded && !p.allIn); }

function setupStreetNeedsAct(opts = {}) {
  currentStreetBet = opts.preservePosted ? currentStreetBet : 0;
  if (!opts.preservePosted) players.forEach(p => { p.streetBet = 0; });
  lastRaiseSize = opts.preservePosted ? lastRaiseSize : BIG_BLIND;
  needsAct = players.map(p => !p.folded && !p.allIn);
}

function toCallFor(i) { return Math.max(0, currentStreetBet - players[i].streetBet); }

function applyAction(i, action, amount = 0) {
  const p = players[i];
  if (action === 'fold') {
    p.folded = true;
    needsAct[i] = false;
    sayAi(i, 'fold');
    return;
  }
  if (action === 'check') {
    needsAct[i] = false;
    sayAi(i, 'check');
    return;
  }
  if (action === 'call') {
    const call = Math.min(toCallFor(i), p.stack);
    p.stack -= call; p.streetBet += call; p.totalContributed += call;
    if (p.stack === 0) p.allIn = true;
    needsAct[i] = false;
    sayAi(i, call > 0 ? 'call' : 'check');
    return;
  }
  if (action === 'raise' || action === 'allin') {
    // amount = montant TOTAL de streetBet visé après relance
    let target = amount;
    const maxTarget = p.streetBet + p.stack;
    if (target >= maxTarget) target = maxTarget; // plafonné au tapis
    const delta = target - p.streetBet;
    p.stack -= delta; p.streetBet += delta; p.totalContributed += delta;
    if (p.stack === 0) p.allIn = true;
    const isFullRaise = target - currentStreetBet >= lastRaiseSize || target === maxTarget;
    if (target > currentStreetBet) {
      lastRaiseSize = Math.max(lastRaiseSize, target - currentStreetBet);
      currentStreetBet = target;
      // Rouvre l'action pour tous les autres joueurs encore décisionnaires
      players.forEach((pl, idx) => {
        if (idx !== i && !pl.folded && !pl.allIn) needsAct[idx] = true;
      });
    }
    needsAct[i] = false;
    sayAi(i, p.allIn ? 'allin' : (currentStreetBet > BIG_BLIND && street !== 'preflop' ? 'raise' : 'raise'));
    return;
  }
}

function processTurn() {
  renderAllSeats();
  renderPlayerBestHand();

  // Un seul joueur restant -> fin de main immédiate
  const remaining = activeNonFolded();
  if (remaining.length === 1) { endHandByFold(remaining[0]); return; }

  // Plus personne à faire agir sur cette rue -> street suivante
  if (needsAct.every(v => !v)) { advanceStreet(); return; }

  // Trouver le prochain joueur qui doit agir
  let guard = 0;
  while (!needsAct[turnIndex] && guard < players.length + 1) {
    turnIndex = (turnIndex + 1) % players.length;
    guard++;
  }
  if (!needsAct[turnIndex]) { advanceStreet(); return; }

  const p = players[turnIndex];
  if (p.isHuman) {
    awaitingHumanAction = true;
    showHumanControls();
    renderAllSeats();
  } else {
    renderAllSeats();
    setTimeout(() => aiTakeTurn(turnIndex), 650 + secureRandomInt(500));
  }
}

function endHandByFold(winner) {
  handInProgress = false;
  const amount = potTotal();
  winner.stack += amount;
  sayDealer(pickLine(DEALER_LINES.foldWin));
  setStatus(`${winner.isHuman ? 'Vous remportez' : winner.name + ' remporte'} le pot de ${amount.toLocaleString('fr-FR')} jetons`, winner.isHuman ? 'win' : (winner.isHuman === false ? 'lose' : ''));
  if (!winner.isHuman) sayAi(players.indexOf(winner), 'win');
  players.forEach(p => p.totalContributed = 0);
  finishHandCleanup();
}

function advanceStreet() {
  players.forEach(p => { p.streetBet = 0; });
  renderAllSeats();

  const decisionMakers = activeDecisionMakers();
  const skipBetting = decisionMakers.length <= 1;

  if (street === 'preflop') {
    dealCommunity(3, 'flop', () => afterCommunityDealt(skipBetting));
  } else if (street === 'flop') {
    dealCommunity(1, 'turn', () => afterCommunityDealt(skipBetting));
  } else if (street === 'turn') {
    dealCommunity(1, 'river', () => afterCommunityDealt(skipBetting));
  } else if (street === 'river') {
    goToShowdown();
  }
}

function afterCommunityDealt(skipBetting) {
  setupStreetNeedsAct();
  turnIndex = nextActiveIndex(dealerIndex, { excludeAllIn: true });
  if (turnIndex === -1) turnIndex = nextActiveIndex(dealerIndex, { excludeAllIn: false });
  renderPlayerBestHand();
  if (skipBetting) {
    // Tout le monde (ou presque) est all-in : on enchaîne le déroulé sans tour de mise
    needsAct = needsAct.map(() => false);
    setTimeout(() => processTurn(), 700);
  } else {
    processTurn();
  }
}

function dealCommunity(count, nextStreetName, callback) {
  street = nextStreetName;
  const lines = DEALER_LINES[nextStreetName] || [];
  if (lines.length) sayDealer(pickLine(lines));
  let delay = 300;
  for (let k = 0; k < count; k++) {
    setTimeout(() => {
      const card = drawCard();
      community.push(card);
      els.communityCards.appendChild(createCardSlot(card, false));
    }, delay);
    delay += 260;
  }
  setTimeout(callback, delay + 150);
}

// ============================================================
// ABATTAGE (showdown) + POTS ANNEXES
// ============================================================
function computePots() {
  const contributors = players.filter(p => p.totalContributed > 0);
  const levels = [...new Set(contributors.map(p => p.totalContributed))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    const diff = level - prev;
    const payers = contributors.filter(p => p.totalContributed >= level);
    const amount = diff * payers.length;
    const eligible = payers.filter(p => !p.folded);
    if (amount > 0 && eligible.length > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

function goToShowdown() {
  street = 'showdown';
  sayDealer(pickLine(DEALER_LINES.showdown));
  handInProgress = false;

  const contenders = activeNonFolded();
  // Révéler toutes les mains encore en lice
  contenders.forEach(p => { if (!p.isHuman) renderAiSeat(players.indexOf(p), { revealCards: true }); });

  const evals = new Map();
  contenders.forEach(p => evals.set(p, evaluateBest([...p.hand, ...community])));

  const pots = computePots();
  const winnersSummary = [];
  let totalAwarded = 0;

  pots.forEach(pot => {
    let best = null;
    let winners = [];
    pot.eligible.forEach(p => {
      const ev = evals.get(p);
      if (!best || compareEval(ev, best) > 0) { best = ev; winners = [p]; }
      else if (compareEval(ev, best) === 0) winners.push(p);
    });
    if (winners.length === 0) return;
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    winners.forEach(w => {
      let amt = share;
      if (remainder > 0) { amt += 1; remainder -= 1; }
      w.stack += amt;
      totalAwarded += amt;
    });
    winnersSummary.push({ winners, amount: pot.amount, label: evals.get(winners[0]).label });
  });

  renderAllSeats();
  renderPlayerBestHand();

  if (winnersSummary.length) {
    const main = winnersSummary[winnersSummary.length - 1];
    const names = main.winners.map(w => w.isHuman ? 'Vous' : w.name).join(' & ');
    const kind = main.winners.some(w => w.isHuman) ? 'win' : (main.winners.length ? 'lose' : '');
    setStatus(`${names} remporte${main.winners.length > 1 ? 'nt' : ''} avec ${main.label} (${totalAwarded.toLocaleString('fr-FR')} jetons)`, kind);
    main.winners.forEach(w => { if (!w.isHuman) sayAi(players.indexOf(w), 'win'); });
  }

  players.forEach(p => p.totalContributed = 0);
  finishHandCleanup();
}

function finishHandCleanup() {
  saveBankroll();
  updateBankrollDisplay();
  renderAllSeats();
  els.gameActions.hidden = true;
  els.raiseZone.hidden = true;
  els.startZone.hidden = false;
  els.startHandBtn.textContent = 'Main suivante';
  awaitingHumanAction = false;
  if (players[0].stack <= 0) {
    setTimeout(() => openRebuyModal(), 900);
  }
}

// ============================================================
// CONTRÔLES DU JOUEUR HUMAIN
// ============================================================
function showHumanControls() {
  const p = players[0];
  const call = toCallFor(0);
  els.gameActions.hidden = false;
  els.raiseZone.hidden = true;
  els.foldBtn.disabled = false;
  els.checkCallBtn.textContent = call > 0 ? `Suivre (${call})` : 'Parole';
  els.checkCallBtn.disabled = false;
  const canRaise = p.stack > call; // il faut des jetons en plus du call pour relancer
  els.raiseBtn.disabled = !canRaise;
  els.raiseBtn.textContent = call > 0 ? 'Relancer' : 'Miser';

  const minRaiseTo = Math.min(currentStreetBet + lastRaiseSize, p.streetBet + p.stack);
  const maxRaiseTo = p.streetBet + p.stack;
  els.raiseSlider.min = Math.max(currentStreetBet + 1, minRaiseTo);
  els.raiseSlider.max = maxRaiseTo;
  els.raiseSlider.value = Math.min(Math.max(minRaiseTo, els.raiseSlider.min), maxRaiseTo);
  updateRaiseReadout();
}

function hideHumanControls() {
  els.gameActions.hidden = true;
  els.raiseZone.hidden = true;
}

function updateRaiseReadout() {
  els.raiseAmountDisplay.textContent = parseInt(els.raiseSlider.value, 10).toLocaleString('fr-FR');
}

function humanAct(action, amount) {
  if (!awaitingHumanAction) return;
  awaitingHumanAction = false;
  hideHumanControls();
  applyAction(0, action, amount);
  turnIndex = nextActiveIndex(0, { excludeAllIn: false });
  processTurn();
}

els.foldBtn.addEventListener('click', () => humanAct('fold'));
els.checkCallBtn.addEventListener('click', () => {
  const call = toCallFor(0);
  humanAct(call > 0 ? 'call' : 'check');
});
els.raiseBtn.addEventListener('click', () => {
  els.gameActions.hidden = true;
  els.raiseZone.hidden = false;
});
els.cancelRaiseBtn.addEventListener('click', () => {
  els.raiseZone.hidden = true;
  els.gameActions.hidden = false;
});
els.raiseSlider.addEventListener('input', updateRaiseReadout);
els.presetHalfPot.addEventListener('click', () => {
  const target = players[0].streetBet + Math.round(potTotal() * 0.5);
  els.raiseSlider.value = clampSlider(target);
  updateRaiseReadout();
});
els.presetPot.addEventListener('click', () => {
  const target = players[0].streetBet + potTotal();
  els.raiseSlider.value = clampSlider(target);
  updateRaiseReadout();
});
els.presetAllin.addEventListener('click', () => {
  els.raiseSlider.value = els.raiseSlider.max;
  updateRaiseReadout();
});
function clampSlider(v) {
  const min = parseInt(els.raiseSlider.min, 10), max = parseInt(els.raiseSlider.max, 10);
  return Math.min(Math.max(v, min), max);
}
els.confirmRaiseBtn.addEventListener('click', () => {
  const target = parseInt(els.raiseSlider.value, 10);
  const isAllin = target >= players[0].streetBet + players[0].stack;
  humanAct(isAllin ? 'allin' : 'raise', target);
});

els.startHandBtn.addEventListener('click', startNewHand);

// ============================================================
// IA — LOGIQUE DE DÉCISION
// ============================================================
function preflopStrength(hand) {
  const values = hand.map(c => c.value).sort((a, b) => b - a);
  const [v1, v2] = values;
  const suited = hand[0].suit === hand[1].suit;
  if (v1 === v2) return Math.min(1, 0.55 + ((v1 - 2) / 12) * 0.45);
  let base = ((v1 + v2 - 4) / 24) * 0.5 + 0.15;
  if (suited) base += 0.08;
  const gap = v1 - v2;
  if (gap <= 1) base += 0.06; else if (gap <= 3) base += 0.02;
  if (v1 === 14) base += 0.05;
  return Math.min(0.95, Math.max(0.05, base));
}

function postflopStrength(hand, communityCards) {
  const cards = [...hand, ...communityCards];
  const best = evaluateBest(cards);
  let score = (best.category / 8) * 0.78 + Math.min(0.12, (best.tiebreak[0] || 0) / 14 * 0.12);
  // Bonus tirage couleur (4 cartes de la même couleur)
  const bySuit = {};
  cards.forEach(c => { bySuit[c.suit] = (bySuit[c.suit] || 0) + 1; });
  if (Object.values(bySuit).some(n => n === 4) && best.category < 5) score += 0.07;
  // Bonus tirage suite (4 valeurs consécutives uniques)
  const uniq = [...new Set(cards.map(c => c.value))].sort((a, b) => a - b);
  for (let i = 0; i + 3 < uniq.length; i++) {
    if (uniq[i + 3] - uniq[i] === 3 && best.category < 4) { score += 0.05; break; }
  }
  return Math.min(1, score);
}

function aiTakeTurn(i) {
  const p = players[i];
  if (p.folded || p.allIn) { needsAct[i] = false; processTurn(); return; }
  const persona = p.personality;
  const call = toCallFor(i);
  const pot = potTotal();

  let strength = street === 'preflop'
    ? preflopStrength(p.hand)
    : postflopStrength(p.hand, community);
  strength += (secureRandom() - 0.5) * 2 * persona.variance;
  strength = Math.min(1, Math.max(0, strength));

  const maxRaiseTo = p.streetBet + p.stack;
  const potOdds = call > 0 ? call / (pot + call) : 0;
  const bluffing = secureRandom() < persona.bluffFreq;

  let action, amount = 0;

  if (call === 0) {
    // Peut faire parole ou miser
    if (strength > persona.betThreshold || bluffing) {
      const betSize = Math.round(pot * (0.45 + persona.aggression * 0.55)) || BIG_BLIND;
      amount = Math.min(p.streetBet + Math.max(betSize, BIG_BLIND), maxRaiseTo);
      action = amount >= maxRaiseTo ? 'allin' : 'raise';
    } else {
      action = 'check';
    }
  } else {
    // Doit répondre à une mise
    const scared = strength < (persona.foldThreshold + potOdds * 0.3);
    if (call >= p.stack) {
      // Décision all-in forcée : suivre ou se coucher
      if (strength > persona.foldThreshold + 0.05 || bluffing && secureRandom() < 0.3) action = 'call';
      else action = 'fold';
    } else if (scared && !bluffing && call > pot * 0.08) {
      action = 'fold';
    } else if (strength > persona.raiseThreshold || (bluffing && secureRandom() < 0.5)) {
      const raiseSize = Math.max(lastRaiseSize, Math.round(pot * (0.5 + persona.aggression * 0.6)));
      amount = Math.min(currentStreetBet + raiseSize, maxRaiseTo);
      action = amount >= maxRaiseTo ? 'allin' : 'raise';
    } else {
      action = 'call';
    }
    // Petite chance de tapis avec une main très forte
    if (strength > 0.88 && secureRandom() < 0.25 + persona.aggression * 0.2) {
      action = 'allin'; amount = maxRaiseTo;
    }
  }

  applyAction(i, action, amount);
  turnIndex = nextActiveIndex(i, { excludeAllIn: false });
  processTurn();
}

// ============================================================
// MODALES
// ============================================================
function openModal(modalEl) { modalEl.classList.add('open'); }
function closeModal(modalEl) { modalEl.classList.remove('open'); }

els.rulesBtn.addEventListener('click', () => openModal(els.rulesModal));
els.closeRulesBtn.addEventListener('click', () => closeModal(els.rulesModal));
els.rulesModal.addEventListener('click', (e) => { if (e.target === els.rulesModal) closeModal(els.rulesModal); });

function openRebuyModal() {
  els.startZone.hidden = true;
  els.gameActions.hidden = true;
  els.raiseZone.hidden = true;
  openModal(els.rebuyModal);
}
els.rebuyBtn.addEventListener('click', () => {
  players[0].stack = START_BANKROLL;
  saveBankroll();
  updateBankrollDisplay();
  renderAllSeats();
  closeModal(els.rebuyModal);
  els.startZone.hidden = false;
  showToast('Rachat effectué : 1000 jetons crédités.');
});

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

// ============================================================
// INITIALISATION
// ============================================================
function init() {
  initPlayers();
  updateBankrollDisplay();
  renderAllSeats();
  setStatus('Bienvenue à la table de Poker — Distribuez pour commencer');
  if (players[0].stack <= 0) openRebuyModal();
}

init();
