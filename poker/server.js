'use strict';

/* ============================================================
   POKER TEXAS HOLD'EM — serveur multijoueur (table partagée unique)
   ------------------------------------------------------------
   Un seul serveur Node (Express pour le statique + ws pour le
   websocket, un seul port) fait autorité sur UNE table publique de
   6 sièges maximum. Les joueurs humains connectés occupent des
   sièges réels ; les sièges vides sont comblés par les 4 IA à
   personnalité (Marcus, Tonton Roc, Jojo Chaos, Vivian) pour que la
   table ne soit jamais vide et qu'on puisse jouer même seul.

   Règle d'attribution des sièges (simple et déterministe) :
     - Un humain qui rejoint prend en priorité un siège VIDE
       (le premier disponible dans l'ordre des sièges).
     - S'il n'y a plus de siège vide, il prend la place de l'IA la
       « moins récemment active » = celle installée à sa place
       depuis le plus longtemps sans avoir été remplacée
       (seat.lastActiveAt le plus ancien).
     - Cette attribution ne se produit JAMAIS en pleine main (pour
       ne pas voler les cartes d'une IA en cours de jeu) : un humain
       qui se connecte pendant une main patiente en spectateur et
       est assis à la préparation de la main suivante.

   Le moteur de jeu (distribution, blindes tournantes, tours de
   mise, pots annexes, évaluateur 7 cartes, décisions des IA) est
   directement transposé depuis la version solo (poker/script.js) :
   même évaluateur, mêmes personnalités, mêmes seuils de décision.

   Confidentialité : chaque client reçoit un "state" recalculé pour
   LUI (buildStateForViewer) — ses propres cartes sont toujours
   visibles, celles des autres joueurs (humains ou IA) sont masquées
   tant qu'elles ne sont pas showdownées ou qu'un joueur n'a pas
   fold. Il n'existe pas de state global unique diffusé tel quel :
   c'est le point le plus important de ce serveur, à ne jamais
   casser en le modifiant.
   ============================================================ */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

// ---------- Configuration ----------
const PORT = process.env.PORT || 3035;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');

const START_BANKROLL = 1000;
const AI_START_STACK = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MAX_SEATS = 6;

// Durées configurables via variables d'environnement (utile pour les tests).
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS) || 22000;               // temps max pour agir avant fold/check auto
const SITTING_OUT_EVICT_MS = Number(process.env.SITTING_OUT_EVICT_MS) || 3 * 60 * 1000; // délai avant de libérer le siège d'un humain déconnecté
const PAUSE_AFTER_FOLD_WIN_MS = Number(process.env.PAUSE_AFTER_FOLD_WIN_MS) || 4000; // pause d'affichage après une victoire par fold
const PAUSE_AFTER_SHOWDOWN_MS = Number(process.env.PAUSE_AFTER_SHOWDOWN_MS) || 7000; // pause d'affichage après un abattage
const IDLE_RECHECK_MS = Number(process.env.IDLE_RECHECK_MS) || 1500;                // fréquence de nouvelle tentative quand la table est vide
const DEAL_STEP_MS = Number(process.env.DEAL_STEP_MS) || 110;                       // cadence de distribution des cartes privées
const COMMUNITY_STEP_MS = Number(process.env.COMMUNITY_STEP_MS) || 260;             // cadence de pose des cartes communes
const AI_THINK_MIN_MS = 650;
const AI_THINK_VARIANCE_MS = 500;

const SUITS = [
  { key: 'spades', symbol: '♠', color: 'black' },
  { key: 'hearts', symbol: '♥', color: 'red' },
  { key: 'diamonds', symbol: '♦', color: 'red' },
  { key: 'clubs', symbol: '♣', color: 'black' },
];
const RANKS = [
  { rank: '2', value: 2 }, { rank: '3', value: 3 }, { rank: '4', value: 4 },
  { rank: '5', value: 5 }, { rank: '6', value: 6 }, { rank: '7', value: 7 },
  { rank: '8', value: 8 }, { rank: '9', value: 9 }, { rank: '10', value: 10 },
  { rank: 'J', value: 11 }, { rank: 'Q', value: 12 }, { rank: 'K', value: 13 },
  { rank: 'A', value: 14 },
];

const HAND_LABELS = [
  'Carte haute', 'Paire', 'Double paire', 'Brelan', 'Suite',
  'Couleur', 'Full', 'Carré', 'Quinte flush',
];

// ---------- Personnalités des adversaires IA (reprises de la version solo) ----------
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

const DEALER_LINES = {
  newHand: ['Nouvelle donne, mesdames et messieurs.', 'On rebat les cartes.'],
  preflop: ['Les paris sont ouverts.', 'À vous de jouer.'],
  flop: ['Le flop.'],
  turn: ['Le turn.'],
  river: ['La rivière.'],
  showdown: ['Les jeux sont faits.', 'Abattage des cartes.'],
  foldWin: ['La table s\'incline, un seul joueur reste en lice.'],
};

const HUMAN_AVATARS = ['🧑', '👩', '🧔', '👨', '🧑‍🦱', '👩‍🦰', '🧑‍🦳', '👨‍🦲'];

// ---------- Persistance des soldes (globale, sur disque) ----------
// { [playerId]: { name, bankroll } }
let playersDB = {};

function loadPlayersDB() {
  try {
    const raw = fs.readFileSync(PLAYERS_FILE, 'utf8');
    playersDB = JSON.parse(raw);
  } catch {
    playersDB = {};
  }
}

let saveScheduled = false;
function savePlayersDB() {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PLAYERS_FILE, JSON.stringify(playersDB, null, 2));
    } catch (err) {
      console.error('Erreur écriture players.json :', err);
    }
  });
}

function randomName() {
  return `Joueur ${1000 + crypto.randomInt(9000)}`;
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  // Retire les caracteres de controle (espaces, accents, tirets et emojis de pseudo sont conserves).
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 20);
  return cleaned.length ? cleaned : null;
}

function getOrCreatePlayerRecord(playerId, initialName) {
  if (!playersDB[playerId]) {
    playersDB[playerId] = { name: sanitizeName(initialName) || randomName(), bankroll: START_BANKROLL };
    savePlayersDB();
  }
  return playersDB[playerId];
}

function persistHumanBankroll(seat) {
  if (seat.type !== 'human' || !seat.playerId) return;
  const rec = getOrCreatePlayerRecord(seat.playerId);
  rec.bankroll = seat.stack;
  savePlayersDB();
}

function pickHumanAvatar(playerId) {
  let sum = 0;
  for (const ch of String(playerId)) sum += ch.charCodeAt(0);
  return HUMAN_AVATARS[sum % HUMAN_AVATARS.length];
}

// ---------- Générateur aléatoire cryptographique ----------
function secureRandom() {
  return crypto.randomInt(0, 1_000_000_000) / 1_000_000_000;
}
function secureRandomInt(maxExclusive) {
  return crypto.randomInt(maxExclusive);
}
function pickLine(arr) {
  return arr[secureRandomInt(arr.length)];
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Paquet de cartes ----------
function buildDeck() {
  const d = [];
  for (const suit of SUITS) {
    for (const r of RANKS) {
      d.push({ rank: r.rank, value: r.value, suit: suit.key, symbol: suit.symbol, color: suit.color });
    }
  }
  return d;
}
function shuffle(deck) {
  const passes = 3;
  for (let p = 0; p < passes; p++) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }
  return deck;
}
function drawCard() {
  return table.deck.pop();
}

// ============================================================
// ÉVALUATEUR DE MAINS (7 cartes -> meilleure combinaison de 5)
// Transposé tel quel depuis la version solo — logique déjà testée.
// ============================================================
function combinations5(cards) {
  const result = [];
  const n = cards.length;
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
  const values = cards.map((c) => c.value).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.suit === cards[0].suit);

  const uniqueVals = [...new Set(values)];
  let straightHigh = null;
  if (uniqueVals.length === 5) {
    if (uniqueVals[0] - uniqueVals[4] === 4) straightHigh = uniqueVals[0];
    else if (uniqueVals.join(',') === '14,5,4,3,2') straightHigh = 5; // roue A-5
  }

  const countMap = {};
  for (const v of values) countMap[v] = (countMap[v] || 0) + 1;
  const groups = Object.entries(countMap)
    .map(([v, c]) => ({ value: parseInt(v, 10), count: c }))
    .sort((a, b) => (b.count - a.count) || (b.value - a.value));

  const kickersFlat = () => groups.flatMap((g) => Array(g.count).fill(g.value));

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
// IA — LOGIQUE DE DÉCISION (transposée de la version solo)
// ============================================================
function preflopStrength(hand) {
  const values = hand.map((c) => c.value).sort((a, b) => b - a);
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
  const bySuit = {};
  cards.forEach((c) => { bySuit[c.suit] = (bySuit[c.suit] || 0) + 1; });
  if (Object.values(bySuit).some((n) => n === 4) && best.category < 5) score += 0.07;
  const uniq = [...new Set(cards.map((c) => c.value))].sort((a, b) => a - b);
  for (let i = 0; i + 3 < uniq.length; i++) {
    if (uniq[i + 3] - uniq[i] === 3 && best.category < 4) { score += 0.05; break; }
  }
  return Math.min(1, score);
}

function computeAiDecision(seatIndex) {
  const s = table.seats[seatIndex];
  const persona = s.personality;
  const call = toCallFor(seatIndex);
  const pot = potTotal();

  let strength = table.street === 'preflop'
    ? preflopStrength(s.hand)
    : postflopStrength(s.hand, table.community);
  strength += (secureRandom() - 0.5) * 2 * persona.variance;
  strength = Math.min(1, Math.max(0, strength));

  const maxRaiseTo = s.streetBet + s.stack;
  const potOdds = call > 0 ? call / (pot + call) : 0;
  const bluffing = secureRandom() < persona.bluffFreq;

  let action;
  let amount = 0;

  if (call === 0) {
    if (strength > persona.betThreshold || bluffing) {
      const betSize = Math.round(pot * (0.45 + persona.aggression * 0.55)) || BIG_BLIND;
      amount = Math.min(s.streetBet + Math.max(betSize, BIG_BLIND), maxRaiseTo);
      action = 'raise';
    } else {
      action = 'check';
    }
  } else {
    const scared = strength < (persona.foldThreshold + potOdds * 0.3);
    if (call >= s.stack) {
      if (strength > persona.foldThreshold + 0.05 || (bluffing && secureRandom() < 0.3)) action = 'call';
      else action = 'fold';
    } else if (scared && !bluffing && call > pot * 0.08) {
      action = 'fold';
    } else if (strength > persona.raiseThreshold || (bluffing && secureRandom() < 0.5)) {
      const raiseSize = Math.max(table.lastRaiseSize, Math.round(pot * (0.5 + persona.aggression * 0.6)));
      amount = Math.min(table.currentStreetBet + raiseSize, maxRaiseTo);
      action = 'raise';
    } else {
      action = 'call';
    }
    if (strength > 0.88 && secureRandom() < 0.25 + persona.aggression * 0.2) {
      action = 'raise'; amount = maxRaiseTo;
    }
  }
  return { action, amount };
}

// ============================================================
// ÉTAT DE LA TABLE (siège x6)
// ============================================================
function emptySeat(index) {
  return {
    index,
    type: 'empty',      // 'empty' | 'ai' | 'human'
    playerId: null,
    aiId: null,
    personality: null,
    name: '',
    avatar: '',
    tag: '',
    stack: 0,
    hand: [],
    folded: false,
    allIn: false,
    streetBet: 0,
    totalContributed: 0,
    sockets: new Set(), // humains uniquement
    connected: false,   // humains uniquement (true en permanence pour les IA)
    sittingOutSince: null,
    lastActiveAt: 0,
  };
}

const table = {
  seats: Array.from({ length: MAX_SEATS }, (_, i) => emptySeat(i)),
  deck: [],
  community: [],
  handNumber: 0,
  dealerSeatIndex: -1,
  sbSeatIndex: -1,
  bbSeatIndex: -1,
  street: 'idle', // idle | preflop | flop | turn | river | showdown
  currentStreetBet: 0,
  lastRaiseSize: BIG_BLIND,
  needsAct: Array(MAX_SEATS).fill(false),
  turnSeatIndex: -1,
  turnDeadline: null,
  nextHandAt: null,
  handInProgress: false,
  statusMessage: 'En attente de joueurs…',
  statusKind: '',
  lastWinners: [],
  currentTurnResolver: null,
  currentTurnTimer: null,
};

// playerId -> Set<ws> pour les humains connectés mais pas encore assis
// (en attente d'une place, en dehors d'une reconnexion sur un siège existant).
const pendingSockets = new Map();
let humanConnectedResolvers = [];

// ============================================================
// GESTION DES SIÈGES
// ============================================================
function findSeatByPlayerId(playerId) {
  return table.seats.find((s) => s.type === 'human' && s.playerId === playerId) || null;
}

function occupiedSeats() {
  return table.seats.filter((s) => s.type !== 'empty');
}

function anyHumanConnected() {
  return table.seats.some((s) => s.type === 'human' && s.connected);
}

function wrapSeat(i) {
  return ((i % MAX_SEATS) + MAX_SEATS) % MAX_SEATS;
}

// Prochain siège OCCUPÉ (humain ou IA), sans condition sur fold/all-in —
// utilisé pour faire tourner le bouton donneur.
function nextOccupiedSeatIndex(from) {
  let i = from;
  for (let step = 0; step < MAX_SEATS; step++) {
    i = wrapSeat(i + 1);
    if (table.seats[i].type !== 'empty') return i;
  }
  return -1;
}

// Prochain siège encore EN JEU sur la main en cours (pas couché, et pas
// all-in si demandé) — utilisé pour les tours de mise.
function nextActiveSeatIndex(from, opts = {}) {
  const excludeAllIn = opts.excludeAllIn !== false;
  let i = from;
  for (let step = 0; step < MAX_SEATS; step++) {
    i = wrapSeat(i + 1);
    const s = table.seats[i];
    if (s.type === 'empty' || s.folded) continue;
    if (excludeAllIn && s.allIn) continue;
    return i;
  }
  return -1;
}

// Liste des sièges occupés, en partant du bouton donneur (inclus) et dans
// le sens du jeu — sert à l'ordre de distribution et au calcul heads-up.
function occupiedFromButton() {
  const list = [];
  let i = table.dealerSeatIndex;
  for (let step = 0; step < MAX_SEATS; step++) {
    if (table.seats[i].type !== 'empty') list.push(i);
    i = wrapSeat(i + 1);
  }
  return list;
}

function resetSeatToEmpty(seat) {
  seat.type = 'empty';
  seat.playerId = null;
  seat.aiId = null;
  seat.personality = null;
  seat.name = '';
  seat.avatar = '';
  seat.tag = '';
  seat.stack = 0;
  seat.hand = [];
  seat.folded = false;
  seat.allIn = false;
  seat.streetBet = 0;
  seat.totalContributed = 0;
  seat.sockets = new Set();
  seat.connected = false;
  seat.sittingOutSince = null;
  seat.lastActiveAt = 0;
}

function occupySeatWithHuman(seatIndex, playerId, sockets) {
  const rec = getOrCreatePlayerRecord(playerId);
  const seat = table.seats[seatIndex];
  seat.type = 'human';
  seat.playerId = playerId;
  seat.aiId = null;
  seat.personality = null;
  seat.name = rec.name;
  seat.avatar = pickHumanAvatar(playerId);
  seat.tag = '';
  seat.stack = rec.bankroll;
  seat.hand = [];
  seat.folded = false;
  seat.allIn = false;
  seat.streetBet = 0;
  seat.totalContributed = 0;
  seat.sockets = sockets;
  seat.connected = true;
  seat.sittingOutSince = null;
  seat.lastActiveAt = Date.now();
}

// Trouve un siège vide, sinon évince l'IA la « moins récemment active »
// (installée à sa place depuis le plus longtemps). Renvoie -1 si la table
// est pleine d'humains.
function findFreeSeatOrEvictAI() {
  for (let i = 0; i < MAX_SEATS; i++) {
    if (table.seats[i].type === 'empty') return i;
  }
  let target = -1;
  let oldest = Infinity;
  for (let i = 0; i < MAX_SEATS; i++) {
    const s = table.seats[i];
    if (s.type === 'ai' && s.lastActiveAt < oldest) { oldest = s.lastActiveAt; target = i; }
  }
  return target;
}

// N'assoit jamais un humain en pleine main (on ne vole pas les cartes d'une
// IA en cours de jeu) : les joueurs en attente sont traités entre deux mains.
function maybeSeatWaitingHumans() {
  if (table.handInProgress) return;
  for (const playerId of [...pendingSockets.keys()]) {
    const seatIndex = findFreeSeatOrEvictAI();
    if (seatIndex === -1) break; // table pleine d'humains, on patiente
    const sockets = pendingSockets.get(playerId);
    pendingSockets.delete(playerId);
    occupySeatWithHuman(seatIndex, playerId, sockets);
  }
}

function fillEmptySeatsWithAI() {
  const usedAiIds = new Set(table.seats.filter((s) => s.type === 'ai').map((s) => s.aiId));
  const available = PERSONALITIES.filter((p) => !usedAiIds.has(p.id));
  let ai = 0;
  for (let i = 0; i < MAX_SEATS && ai < available.length; i++) {
    if (table.seats[i].type !== 'empty') continue;
    const persona = available[ai++];
    const seat = table.seats[i];
    seat.type = 'ai';
    seat.playerId = null;
    seat.aiId = persona.id;
    seat.personality = persona;
    seat.name = persona.name;
    seat.avatar = persona.avatar;
    seat.tag = persona.tag;
    seat.stack = AI_START_STACK;
    seat.hand = [];
    seat.folded = false;
    seat.allIn = false;
    seat.streetBet = 0;
    seat.totalContributed = 0;
    seat.sockets = new Set();
    seat.connected = true;
    seat.sittingOutSince = null;
    seat.lastActiveAt = Date.now(); // depuis quand ce siège est occupé (sert à l'éviction)
  }
}

function evictStaleSittingOut() {
  const now = Date.now();
  for (const seat of table.seats) {
    if (seat.type === 'human' && !seat.connected && seat.sittingOutSince
        && (now - seat.sittingOutSince > SITTING_OUT_EVICT_MS)) {
      persistHumanBankroll(seat);
      resetSeatToEmpty(seat);
    }
  }
}

function autoRebuyBustedSeats() {
  for (const seat of table.seats) {
    if (seat.type === 'empty' || seat.stack > 0) continue;
    seat.stack = seat.type === 'human' ? START_BANKROLL : AI_START_STACK;
    if (seat.type === 'human') persistHumanBankroll(seat);
  }
}

function prepareSeatsForNewHand() {
  evictStaleSittingOut();
  maybeSeatWaitingHumans();
  fillEmptySeatsWithAI();
  autoRebuyBustedSeats();
}

// ============================================================
// MOTEUR DE MISES
// ============================================================
function activeNonFolded() {
  return table.seats.filter((s) => s.type !== 'empty' && !s.folded);
}
function activeDecisionMakers() {
  return table.seats.filter((s) => s.type !== 'empty' && !s.folded && !s.allIn);
}
function potTotal() {
  return table.seats.reduce((sum, s) => sum + (s.totalContributed || 0), 0);
}
function toCallFor(seatIndex) {
  return Math.max(0, table.currentStreetBet - table.seats[seatIndex].streetBet);
}

function postBlind(seatIndex, amount) {
  const s = table.seats[seatIndex];
  const actual = Math.min(amount, s.stack);
  s.stack -= actual;
  s.streetBet += actual;
  s.totalContributed += actual;
  if (s.stack === 0) s.allIn = true;
  if (s.type === 'human') persistHumanBankroll(s);
}

function applyAction(seatIndex, action, amount = 0) {
  const s = table.seats[seatIndex];
  if (action === 'fold') {
    s.folded = true;
    table.needsAct[seatIndex] = false;
    sayAi(seatIndex, 'fold');
    return;
  }
  if (action === 'check') {
    table.needsAct[seatIndex] = false;
    sayAi(seatIndex, 'check');
    return;
  }
  if (action === 'call') {
    const call = Math.min(toCallFor(seatIndex), s.stack);
    s.stack -= call; s.streetBet += call; s.totalContributed += call;
    if (s.stack === 0) s.allIn = true;
    if (s.type === 'human') persistHumanBankroll(s);
    table.needsAct[seatIndex] = false;
    sayAi(seatIndex, call > 0 ? 'call' : 'check');
    return;
  }
  if (action === 'raise') {
    let target = amount;
    const maxTarget = s.streetBet + s.stack;
    if (target >= maxTarget) target = maxTarget;
    const delta = target - s.streetBet;
    s.stack -= delta; s.streetBet += delta; s.totalContributed += delta;
    if (s.stack === 0) s.allIn = true;
    if (s.type === 'human') persistHumanBankroll(s);
    if (target > table.currentStreetBet) {
      table.lastRaiseSize = Math.max(table.lastRaiseSize, target - table.currentStreetBet);
      table.currentStreetBet = target;
      // Rouvre l'action pour tous les autres joueurs encore décisionnaires
      for (let i = 0; i < MAX_SEATS; i++) {
        const other = table.seats[i];
        if (i !== seatIndex && other.type !== 'empty' && !other.folded && !other.allIn) table.needsAct[i] = true;
      }
    }
    table.needsAct[seatIndex] = false;
    sayAi(seatIndex, s.allIn ? 'allin' : 'raise');
  }
}

function computePots() {
  const contributors = table.seats.filter((s) => s.type !== 'empty' && s.totalContributed > 0);
  const levels = [...new Set(contributors.map((s) => s.totalContributed))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    const diff = level - prev;
    const payers = contributors.filter((s) => s.totalContributed >= level);
    const amount = diff * payers.length;
    const eligible = payers.filter((s) => !s.folded);
    if (amount > 0 && eligible.length > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

// ---------- Attente de l'action d'un joueur humain (avec timeout) ----------
function waitForHumanAction(seatIndex, timeoutMs) {
  return new Promise((resolve) => {
    const finish = (action, amount) => {
      clearTimeout(table.currentTurnTimer);
      table.currentTurnResolver = null;
      resolve({ action, amount });
    };
    table.currentTurnResolver = finish;
    table.currentTurnTimer = setTimeout(() => {
      const call = toCallFor(seatIndex);
      finish(call > 0 ? 'fold' : 'check', 0);
    }, timeoutMs);
  });
}

function submitPlayerAction(seatIndex, action, amount) {
  if (table.turnSeatIndex === seatIndex && table.currentTurnResolver) {
    table.currentTurnResolver(action, amount);
  }
}

async function bettingRound() {
  for (;;) {
    const remaining = activeNonFolded();
    if (remaining.length <= 1) return;
    if (table.needsAct.every((v) => !v)) return;

    let guard = 0;
    while (!table.needsAct[table.turnSeatIndex] && guard < MAX_SEATS + 1) {
      table.turnSeatIndex = wrapSeat(table.turnSeatIndex + 1);
      guard++;
    }
    if (!table.needsAct[table.turnSeatIndex]) return;

    const seatIndex = table.turnSeatIndex;
    const seat = table.seats[seatIndex];
    table.turnDeadline = (seat.type === 'human' && seat.connected) ? Date.now() + TURN_TIMEOUT_MS : null;
    broadcastState();

    let action;
    let amount = 0;
    if (seat.type === 'human') {
      if (seat.connected) {
        const r = await waitForHumanAction(seatIndex, TURN_TIMEOUT_MS);
        action = r.action; amount = r.amount;
      } else {
        // Déconnecté : on ne fait pas attendre la table, action auto immédiate.
        action = toCallFor(seatIndex) > 0 ? 'fold' : 'check';
      }
    } else {
      await delay(AI_THINK_MIN_MS + secureRandomInt(AI_THINK_VARIANCE_MS));
      const d = computeAiDecision(seatIndex);
      action = d.action; amount = d.amount;
    }

    applyAction(seatIndex, action, amount);
    table.turnSeatIndex = nextActiveSeatIndex(seatIndex, { excludeAllIn: false });
    table.turnDeadline = null;
    broadcastState();
  }
}

// ============================================================
// DÉROULÉ D'UNE MAIN
// ============================================================
function resetHandState() {
  table.community = [];
  table.deck = shuffle(buildDeck());
  table.lastWinners = [];
  table.statusKind = '';
  for (const s of table.seats) {
    if (s.type === 'empty') continue;
    s.hand = []; s.folded = false; s.allIn = false;
    s.streetBet = 0; s.totalContributed = 0;
  }
}

async function runBettingStreet(streetName, cardCount) {
  table.seats.forEach((s) => { if (s.type !== 'empty') s.streetBet = 0; });
  table.street = streetName;
  const lines = DEALER_LINES[streetName] || [];
  if (lines.length) dealerSay(pickLine(lines));
  broadcastState();

  for (let k = 0; k < cardCount; k++) {
    table.community.push(drawCard());
    broadcastState();
    await delay(COMMUNITY_STEP_MS);
  }

  table.currentStreetBet = 0;
  table.lastRaiseSize = BIG_BLIND;
  table.needsAct = Array(MAX_SEATS).fill(false);
  for (let i = 0; i < MAX_SEATS; i++) {
    const s = table.seats[i];
    if (s.type !== 'empty' && !s.folded && !s.allIn) table.needsAct[i] = true;
  }
  table.turnSeatIndex = nextActiveSeatIndex(table.dealerSeatIndex, { excludeAllIn: true });
  if (table.turnSeatIndex === -1) table.turnSeatIndex = nextActiveSeatIndex(table.dealerSeatIndex, { excludeAllIn: false });

  const decisionMakers = activeDecisionMakers();
  if (decisionMakers.length <= 1) {
    // Tout le monde (ou presque) est all-in : on enchaîne sans tour de mise.
    broadcastState();
    await delay(700);
    return;
  }
  await bettingRound();
}

async function endHandByFold(winnerSeat) {
  table.handInProgress = false;
  const amount = potTotal();
  winnerSeat.stack += amount;
  if (winnerSeat.type === 'human') persistHumanBankroll(winnerSeat);
  dealerSay(pickLine(DEALER_LINES.foldWin));
  table.statusMessage = `${winnerSeat.name} remporte le pot de ${amount.toLocaleString('fr-FR')} jetons`;
  table.statusKind = 'win';
  table.lastWinners = [winnerSeat.index];
  if (winnerSeat.type === 'ai') sayAi(winnerSeat.index, 'win');
  table.seats.forEach((s) => { s.totalContributed = 0; });
  table.turnSeatIndex = -1;
  table.turnDeadline = null;
  table.nextHandAt = Date.now() + PAUSE_AFTER_FOLD_WIN_MS;
  broadcastState();
  await delay(PAUSE_AFTER_FOLD_WIN_MS);
}

async function goToShowdown() {
  table.street = 'showdown';
  table.handInProgress = false;
  dealerSay(pickLine(DEALER_LINES.showdown));

  const contenders = activeNonFolded();
  const evals = new Map();
  contenders.forEach((s) => evals.set(s, evaluateBest([...s.hand, ...table.community])));

  const pots = computePots();
  let totalAwarded = 0;
  const winnersSet = new Set();
  let mainLabel = '';
  let mainNames = [];

  pots.forEach((pot) => {
    let best = null;
    let winners = [];
    pot.eligible.forEach((s) => {
      const ev = evals.get(s);
      if (!best || compareEval(ev, best) > 0) { best = ev; winners = [s]; }
      else if (compareEval(ev, best) === 0) winners.push(s);
    });
    if (!winners.length) return;
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    winners.forEach((w) => {
      let amt = share;
      if (remainder > 0) { amt += 1; remainder -= 1; }
      w.stack += amt;
      if (w.type === 'human') persistHumanBankroll(w);
      totalAwarded += amt;
      winnersSet.add(w.index);
    });
    mainLabel = evals.get(winners[0]).label;
    mainNames = winners.map((w) => w.name);
  });

  table.seats.forEach((s) => { s.totalContributed = 0; });
  table.lastWinners = [...winnersSet];
  table.statusMessage = mainNames.length
    ? `${mainNames.join(' & ')} remporte${mainNames.length > 1 ? 'nt' : ''} avec ${mainLabel} (${totalAwarded.toLocaleString('fr-FR')} jetons)`
    : 'Manche terminée';
  table.statusKind = 'win';
  winnersSet.forEach((idx) => { if (table.seats[idx].type === 'ai') sayAi(idx, 'win'); });

  table.turnSeatIndex = -1;
  table.turnDeadline = null;
  table.nextHandAt = Date.now() + PAUSE_AFTER_SHOWDOWN_MS;
  broadcastState();
  await delay(PAUSE_AFTER_SHOWDOWN_MS);
}

async function playHand() {
  resetHandState();
  table.handNumber += 1;
  table.dealerSeatIndex = nextOccupiedSeatIndex(table.dealerSeatIndex);
  const occupied = occupiedFromButton();

  table.handInProgress = true;
  table.street = 'preflop';
  table.statusMessage = 'Nouvelle main';
  table.statusKind = '';
  table.nextHandAt = null;
  dealerSay(pickLine(DEALER_LINES.newHand));
  broadcastState();

  let sbSeat;
  let bbSeat;
  if (occupied.length === 2) {
    // Heads-up : le bouton poste la petite blinde et agit en premier au preflop.
    sbSeat = table.dealerSeatIndex;
    bbSeat = occupied.find((i) => i !== sbSeat);
  } else {
    sbSeat = nextOccupiedSeatIndex(table.dealerSeatIndex);
    bbSeat = nextOccupiedSeatIndex(sbSeat);
  }
  table.sbSeatIndex = sbSeat;
  table.bbSeatIndex = bbSeat;

  postBlind(sbSeat, SMALL_BLIND);
  postBlind(bbSeat, BIG_BLIND);
  table.currentStreetBet = BIG_BLIND;
  table.lastRaiseSize = BIG_BLIND;
  table.needsAct = Array(MAX_SEATS).fill(false);
  occupied.forEach((i) => {
    const s = table.seats[i];
    table.needsAct[i] = !s.folded && !s.allIn;
  });
  broadcastState();

  // Distribution des cartes privées (2 tours, cascade depuis la petite blinde).
  const sbPos = occupied.indexOf(sbSeat);
  const dealOrder = occupied.slice(sbPos).concat(occupied.slice(0, sbPos));
  for (let round = 0; round < 2; round++) {
    for (const i of dealOrder) {
      table.seats[i].hand.push(drawCard());
      broadcastState();
      await delay(DEAL_STEP_MS);
    }
  }

  table.turnSeatIndex = nextActiveSeatIndex(bbSeat, { excludeAllIn: true });
  if (table.turnSeatIndex === -1) table.turnSeatIndex = nextActiveSeatIndex(table.dealerSeatIndex, { excludeAllIn: false });
  dealerSay(pickLine(DEALER_LINES.preflop));
  table.statusMessage = 'Les paris sont ouverts';
  broadcastState();

  await bettingRound();
  if (activeNonFolded().length <= 1) { await endHandByFold(activeNonFolded()[0]); return; }

  await runBettingStreet('flop', 3);
  if (activeNonFolded().length <= 1) { await endHandByFold(activeNonFolded()[0]); return; }

  await runBettingStreet('turn', 1);
  if (activeNonFolded().length <= 1) { await endHandByFold(activeNonFolded()[0]); return; }

  await runBettingStreet('river', 1);
  if (activeNonFolded().length <= 1) { await endHandByFold(activeNonFolded()[0]); return; }

  await goToShowdown();
}

// ---------- Attente qu'au moins un humain soit connecté ----------
function waitForAnyHumanConnected() {
  if (anyHumanConnected()) return Promise.resolve();
  return new Promise((resolve) => humanConnectedResolvers.push(resolve));
}
function wakeLoop() {
  if (!anyHumanConnected() || humanConnectedResolvers.length === 0) return;
  const resolvers = humanConnectedResolvers;
  humanConnectedResolvers = [];
  resolvers.forEach((r) => r());
}

async function runTableLoop() {
  for (;;) {
    await waitForAnyHumanConnected();
    prepareSeatsForNewHand();
    if (occupiedSeats().length < 2) {
      table.street = 'idle';
      table.statusMessage = 'En attente de joueurs…';
      table.nextHandAt = null;
      broadcastState();
      await delay(IDLE_RECHECK_MS);
      continue;
    }
    await playHand();
  }
}

// ============================================================
// SÉRIALISATION PAR SPECTATEUR (point critique : jamais de fuite)
// ============================================================
function serializeCardPublic(card) {
  return { rank: card.rank, suit: card.suit, symbol: card.symbol, color: card.color };
}

function serializeSeat(seat, viewerPlayerId, revealAll) {
  if (seat.type === 'empty') {
    return { index: seat.index, type: 'empty' };
  }
  const isYou = seat.type === 'human' && seat.playerId === viewerPlayerId;
  let cards = [];
  if (seat.hand.length) {
    if (isYou) cards = seat.hand.map(serializeCardPublic);
    else if (seat.folded) cards = [];
    else if (revealAll) cards = seat.hand.map(serializeCardPublic);
    else cards = seat.hand.map(() => ({ hidden: true }));
  }
  return {
    index: seat.index,
    type: seat.type,
    name: seat.name,
    avatar: seat.avatar,
    tag: seat.tag,
    isYou,
    connected: seat.type === 'human' ? seat.connected : true,
    stack: seat.stack,
    streetBet: seat.streetBet,
    folded: seat.folded,
    allIn: seat.allIn,
    cards,
  };
}

function buildStateForViewer(viewerPlayerId) {
  const revealAll = table.street === 'showdown';
  const viewerSeat = viewerPlayerId ? findSeatByPlayerId(viewerPlayerId) : null;

  let you = null;
  if (viewerPlayerId) {
    const rec = getOrCreatePlayerRecord(viewerPlayerId);
    if (viewerSeat) {
      const call = toCallFor(viewerSeat.index);
      const maxRaiseTo = viewerSeat.streetBet + viewerSeat.stack;
      const minRaiseTo = Math.min(table.currentStreetBet + table.lastRaiseSize, maxRaiseTo);
      let bestHandLabel = '';
      if (viewerSeat.hand.length === 2 && table.community.length > 0 && !viewerSeat.folded) {
        bestHandLabel = evaluateBest([...viewerSeat.hand, ...table.community]).label;
      }
      you = {
        playerId: viewerPlayerId,
        name: rec.name,
        bankroll: viewerSeat.stack,
        seatIndex: viewerSeat.index,
        waiting: false,
        toCall: call,
        canRaise: viewerSeat.stack > call,
        minRaiseTo: Math.max(table.currentStreetBet + 1, minRaiseTo),
        maxRaiseTo,
        // NB : on ne conditionne PAS ce flag à l'existence de
        // table.currentTurnResolver — il n'est posé qu'à l'intérieur de
        // waitForHumanAction(), appelée APRÈS le broadcastState() qui
        // annonce le tour. Le comparer ici renverrait systématiquement
        // faux au moment précis où le client doit pourtant afficher les
        // boutons d'action.
        isYourTurn: table.turnSeatIndex === viewerSeat.index,
        bestHandLabel,
      };
    } else {
      you = {
        playerId: viewerPlayerId,
        name: rec.name,
        bankroll: rec.bankroll,
        seatIndex: null,
        waiting: true,
      };
    }
  }

  return {
    type: 'state',
    handNumber: table.handNumber,
    street: table.street,
    handInProgress: table.handInProgress,
    statusMessage: table.statusMessage,
    statusKind: table.statusKind,
    potTotal: potTotal(),
    community: table.community.map(serializeCardPublic),
    dealerSeat: table.dealerSeatIndex,
    sbSeat: table.sbSeatIndex,
    bbSeat: table.bbSeatIndex,
    turnSeat: table.turnSeatIndex,
    turnDeadline: table.turnDeadline,
    nextHandAt: table.nextHandAt,
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    winners: table.lastWinners || [],
    seats: table.seats.map((s) => serializeSeat(s, viewerPlayerId, revealAll)),
    you,
  };
}

// ============================================================
// WEBSOCKET : envoi / diffusion
// ============================================================
const wss = new WebSocketServer({ noServer: true });

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }
}

function forEachSocket(cb) {
  for (const s of table.seats) {
    if (s.type === 'human') for (const ws of s.sockets) cb(ws);
  }
  for (const set of pendingSockets.values()) for (const ws of set) cb(ws);
}

function broadcastAll(payload) {
  const raw = JSON.stringify(payload);
  forEachSocket((ws) => { if (ws.readyState === ws.OPEN) ws.send(raw); });
}

// Diffuse un "state" DIFFÉRENT à chaque destinataire (voir buildStateForViewer) —
// jamais un seul objet JSON partagé, pour garantir qu'aucune carte privée
// d'un autre joueur humain ne fuite.
function broadcastState() {
  for (const s of table.seats) {
    if (s.type !== 'human' || s.sockets.size === 0) continue;
    const payload = buildStateForViewer(s.playerId);
    const raw = JSON.stringify(payload);
    for (const ws of s.sockets) if (ws.readyState === ws.OPEN) ws.send(raw);
  }
  for (const [playerId, set] of pendingSockets) {
    const payload = buildStateForViewer(playerId);
    const raw = JSON.stringify(payload);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}

function dealerSay(text, duration = 2400) {
  broadcastAll({ type: 'dealerSay', text, duration });
}
function sayAi(seatIndex, category) {
  const s = table.seats[seatIndex];
  if (!s || s.type !== 'ai' || !s.personality) return;
  const lines = s.personality.lines[category];
  if (!lines || !lines.length) return;
  broadcastAll({ type: 'aiSay', seatIndex, text: pickLine(lines), duration: 2400 });
}

// ============================================================
// CONNEXIONS WEBSOCKET
// ============================================================
function attachSocket(ws, playerId) {
  const seat = findSeatByPlayerId(playerId);
  if (seat) {
    seat.sockets.add(ws);
    seat.connected = true;
    seat.sittingOutSince = null;
  } else {
    let set = pendingSockets.get(playerId);
    if (!set) { set = new Set(); pendingSockets.set(playerId, set); }
    set.add(ws);
    maybeSeatWaitingHumans();
  }
}

function detachSocket(ws) {
  const playerId = ws.playerId;
  if (!playerId) return;
  const seat = findSeatByPlayerId(playerId);
  if (seat) {
    seat.sockets.delete(ws);
    if (seat.sockets.size === 0) {
      seat.connected = false;
      seat.sittingOutSince = Date.now();
      // Un joueur qui se déconnecte en pleine main ne doit pas bloquer la
      // table : si c'était son tour, on résout son action immédiatement
      // (fold s'il y a une mise à suivre, check sinon), sans attendre le
      // minuteur complet.
      if (table.turnSeatIndex === seat.index && table.currentTurnResolver) {
        const call = toCallFor(seat.index);
        const finish = table.currentTurnResolver;
        table.currentTurnResolver = null;
        finish(call > 0 ? 'fold' : 'check', 0);
      }
    }
  } else {
    const set = pendingSockets.get(playerId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) pendingSockets.delete(playerId);
    }
  }
  broadcastState();
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello') {
      const playerId = (typeof msg.playerId === 'string' && msg.playerId.length > 0)
        ? msg.playerId
        : crypto.randomUUID();
      ws.playerId = playerId;
      const rec = getOrCreatePlayerRecord(playerId, msg.name);
      attachSocket(ws, playerId);
      send(ws, { type: 'welcome', playerId, name: rec.name, bankroll: rec.bankroll });
      wakeLoop();
      broadcastState();
      return;
    }

    const playerId = ws.playerId;
    if (!playerId) return; // pas encore identifié (hello obligatoire en premier)

    if (msg.type === 'setName') {
      const name = sanitizeName(msg.name);
      if (!name) return;
      const rec = getOrCreatePlayerRecord(playerId);
      rec.name = name;
      savePlayersDB();
      const seat = findSeatByPlayerId(playerId);
      if (seat) seat.name = name;
      broadcastState();
      return;
    }

    if (msg.type === 'action') {
      const seat = findSeatByPlayerId(playerId);
      if (!seat) return;
      if (table.turnSeatIndex !== seat.index || !table.currentTurnResolver) return; // pas son tour
      const call = toCallFor(seat.index);
      const a = msg.action;
      if (a === 'fold') {
        submitPlayerAction(seat.index, 'fold', 0);
      } else if (a === 'check') {
        if (call !== 0) return; // parole invalide si mise à suivre
        submitPlayerAction(seat.index, 'check', 0);
      } else if (a === 'call') {
        submitPlayerAction(seat.index, 'call', 0);
      } else if (a === 'raise') {
        const maxTarget = seat.streetBet + seat.stack;
        let amount = Number(msg.amount);
        if (!Number.isFinite(amount)) return;
        amount = Math.round(amount);
        if (amount > maxTarget) amount = maxTarget;
        if (amount <= table.currentStreetBet) return; // relance invalide
        submitPlayerAction(seat.index, 'raise', amount);
      }
      return;
    }
  });

  ws.on('close', () => detachSocket(ws));
  ws.on('error', () => detachSocket(ws));
});

// Heartbeat : ferme les sockets mortes pour garder l'état "connecté" propre.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

// ---------- Serveur HTTP + fichiers statiques ----------
const app = express();
app.use(express.static(__dirname, { extensions: ['html'] }));

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  // Accepte toute requête d'upgrade se terminant par "/ws" (voir le même
  // choix côté Blackjack) pour rester robuste face à un reverse proxy
  // (nginx) qui pourrait conserver ou retirer le préfixe /poker/.
  const url = (req.url || '').split('?')[0];
  if (url === '/ws' || url.endsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ---------- Démarrage ----------
loadPlayersDB();
server.listen(PORT, () => {
  console.log(`Poker (table partagée) en écoute sur le port ${PORT}`);
  console.log(`HTTP : http://localhost:${PORT}  —  WebSocket : ws://localhost:${PORT}/ws`);
});
runTableLoop().catch((err) => {
  console.error('Erreur fatale dans la boucle de la table :', err);
});
