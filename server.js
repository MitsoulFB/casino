'use strict';

/* ============================================================
   BLACKJACK — serveur de table partagée
   ------------------------------------------------------------
   Un seul serveur Node (Express pour servir les fichiers statiques
   + ws pour le websocket, sur UN SEUL port) fait autorité sur :
     - le sabot de 6 jeux / 312 cartes (mélange crypto, carte de coupe)
     - la boucle de manches (mise -> distribution -> tours -> croupier -> résolution)
     - les soldes de jetons de chaque joueur (persistés sur disque)
   Tous les clients connectés voient la même table, les mêmes cartes
   du croupier, et jouent chacun leurs propres mains à tour de rôle.
   ============================================================ */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

// ---------- Configuration ----------
const PORT = process.env.PORT || 3033;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');

const START_BANKROLL = 1000;
const MAX_HANDS_PER_PLAYER = 4;
// Durées configurables via variables d'environnement (utile pour les tests).
const BETTING_DURATION_MS = Number(process.env.BETTING_DURATION_MS) || 22000;   // durée de la phase de mise
const PAUSE_AFTER_ROUND_MS = Number(process.env.PAUSE_AFTER_ROUND_MS) || 5000;  // pause avant la manche suivante
const EMPTY_ROUND_PAUSE_MS = Number(process.env.EMPTY_ROUND_PAUSE_MS) || 3000;  // pause si personne n'a misé
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS) || 18000;           // temps max pour jouer une main avant "Rester" auto
const DEAL_STEP_MS = 260;
const DEALER_DRAW_MS = 650;

const SUITS = [
  { key: 'spades', symbol: '♠', color: 'black' },
  { key: 'hearts', symbol: '♥', color: 'red' },
  { key: 'diamonds', symbol: '♦', color: 'red' },
  { key: 'clubs', symbol: '♣', color: 'black' },
];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const NUM_DECKS = 6;
const CARDS_PER_DECK = 52;
const SHOE_SIZE = NUM_DECKS * CARDS_PER_DECK; // 312 cartes, sans joker
const CUT_PENETRATION = 0.5; // carte de coupe à 50% du sabot

// ---------- Persistance des soldes ----------
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
  // Écriture différée d'un tick pour regrouper les sauvegardes rapprochées.
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

function getOrCreatePlayerRecord(playerId) {
  if (!playersDB[playerId]) {
    playersDB[playerId] = { name: randomName(), bankroll: START_BANKROLL };
    savePlayersDB();
  }
  return playersDB[playerId];
}

// ---------- Générateur aléatoire cryptographique ----------
function secureRandomInt(maxExclusive) {
  return crypto.randomInt(maxExclusive);
}

// ---------- Gestion du sabot ----------
function buildFreshDecks(numDecks) {
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ rank, suit: suit.key, symbol: suit.symbol, color: suit.color });
      }
    }
  }
  return deck;
}

// Fisher-Yates avec source cryptographique, plusieurs passes.
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

let shoe = [];
let cutCardIndex = 0;
let needsReshuffle = false;

function buildShoe() {
  const deck = shuffle(buildFreshDecks(NUM_DECKS));
  cutCardIndex = Math.floor(deck.length * (1 - CUT_PENETRATION));
  needsReshuffle = false;
  return deck;
}

function drawCard() {
  if (shoe.length === 0) shoe = buildShoe(); // filet de sécurité
  const card = shoe.pop();
  if (shoe.length <= cutCardIndex) needsReshuffle = true;
  return card;
}

function reshuffleShoeIfNeeded() {
  if (!needsReshuffle) return false;
  shoe = buildShoe();
  return true;
}

// ---------- Valeur des mains ----------
function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (card.rank === 'A') { total += 11; aces++; }
    else if (['J', 'Q', 'K'].includes(card.rank)) total += 10;
    else total += parseInt(card.rank, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, isSoft: aces > 0 };
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand).total === 21;
}

// ---------- État de la table ----------
// players : Map(playerId -> { id, name, sockets:Set<ws>, hands:[Hand] })
// Hand : { bet, cards, state, result, payout }
//   state: 'idle' | 'playing' | 'stood' | 'bust' | 'blackjack'
//   result: null | 'win' | 'lose' | 'push'
const players = new Map();

const table = {
  phase: 'betting', // betting | dealing | playing | dealer | resolved
  bettingEndsAt: Date.now() + BETTING_DURATION_MS,
  dealerHand: [],
  dealerHoleRevealed: false,
  turnOrder: [],     // [{ playerId, handIndex }]
  activeTurn: null,  // { playerId, handIndex }
  statusMessage: 'Placez votre mise pour commencer',
  statusKind: '',
};

function newHand() {
  return { bet: 0, cards: [], state: 'idle', result: null, payout: 0 };
}

function getPlayer(playerId) {
  return players.get(playerId);
}

// ---------- WebSocket : envoi ----------
const wss = new WebSocketServer({ noServer: true });

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }
}

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(raw);
  }
}

function serializeCard(card, hidden) {
  if (hidden) return { hidden: true };
  return { rank: card.rank, suit: card.suit, symbol: card.symbol, color: card.color };
}

function serializeState() {
  return {
    type: 'state',
    phase: table.phase,
    bettingEndsAt: table.bettingEndsAt,
    statusMessage: table.statusMessage,
    statusKind: table.statusKind,
    dealer: {
      cards: table.dealerHand.map((c, i) => serializeCard(c, i === 1 && !table.dealerHoleRevealed)),
      holeRevealed: table.dealerHoleRevealed,
      total: table.dealerHoleRevealed ? handValue(table.dealerHand).total : null,
      isSoft: table.dealerHoleRevealed ? handValue(table.dealerHand).isSoft : false,
      isBlackjack: table.dealerHand.length === 2 && isBlackjack(table.dealerHand),
    },
    activeTurn: table.activeTurn,
    playersCount: players.size,
    players: Array.from(players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.sockets.size > 0,
      bankroll: playersDB[p.id] ? playersDB[p.id].bankroll : START_BANKROLL,
      hands: p.hands.map((h) => ({
        bet: h.bet,
        cards: h.cards.map((c) => serializeCard(c, false)),
        state: h.state,
        result: h.result,
        payout: h.payout,
        total: h.cards.length ? handValue(h.cards).total : 0,
        isSoft: h.cards.length ? handValue(h.cards).isSoft : false,
        fromSplit: !!h.fromSplit,
      })),
    })),
    shoe: {
      remaining: shoe.length,
      total: SHOE_SIZE,
      cutCardIndex,
    },
  };
}

function broadcastState() {
  broadcast(serializeState());
}

function dealerSay(text, duration = 2600) {
  broadcast({ type: 'dealerSay', text, duration });
}

function toast(text) {
  broadcast({ type: 'toast', text });
}

// ---------- Utilitaires ----------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Actions des joueurs pendant leur tour ----------
let currentTurnResolver = null;
let currentTurnTimer = null;
let currentTurnKey = null; // `${playerId}:${handIndex}`

function waitForPlayerAction(playerId, handIndex) {
  currentTurnKey = `${playerId}:${handIndex}`;
  return new Promise((resolve) => {
    currentTurnResolver = (action) => {
      clearTimeout(currentTurnTimer);
      currentTurnResolver = null;
      currentTurnKey = null;
      resolve(action);
    };
    currentTurnTimer = setTimeout(() => {
      if (currentTurnResolver) {
        const r = currentTurnResolver;
        currentTurnResolver = null;
        currentTurnKey = null;
        r('stand');
      }
    }, TURN_TIMEOUT_MS);
  });
}

function submitAction(playerId, handIndex, action) {
  const key = `${playerId}:${handIndex}`;
  if (currentTurnKey === key && currentTurnResolver) {
    currentTurnResolver(action);
  }
}

// ---------- Boucle principale de la table ----------
async function runTableLoop() {
  for (;;) {
    await bettingPhase();
    const activeEntries = collectActiveHands();
    if (activeEntries.length === 0) {
      table.statusMessage = 'Personne n\'a misé — nouvelle manche';
      table.statusKind = '';
      broadcastState();
      await delay(EMPTY_ROUND_PAUSE_MS);
      continue;
    }
    await dealingPhase(activeEntries);

    const dealerBJ = isBlackjack(table.dealerHand);
    if (dealerBJ) {
      table.dealerHoleRevealed = true;
      dealerSay('Blackjack pour la maison.');
      resolveAllHands(activeEntries);
    } else {
      table.turnOrder = activeEntries.filter(({ playerId, handIndex }) => {
        const hand = getPlayer(playerId).hands[handIndex];
        return !isBlackjack(hand.cards);
      });
      // Les mains blackjack du joueur restent en attente, sans jouer.
      activeEntries.forEach(({ playerId, handIndex }) => {
        const hand = getPlayer(playerId).hands[handIndex];
        if (isBlackjack(hand.cards)) hand.state = 'blackjack';
      });
      await playingPhase(activeEntries);
      await dealerPhase();
      resolveAllHands(activeEntries);
    }

    broadcastState();
    await delay(PAUSE_AFTER_ROUND_MS);
    resetForNextRound();
  }
}

function collectActiveHands() {
  const entries = [];
  for (const player of players.values()) {
    player.hands.forEach((hand, handIndex) => {
      if (hand.bet > 0) entries.push({ playerId: player.id, handIndex });
    });
  }
  return entries;
}

async function bettingPhase() {
  table.phase = 'betting';
  table.dealerHand = [];
  table.dealerHoleRevealed = false;
  table.turnOrder = [];
  table.activeTurn = null;
  table.bettingEndsAt = Date.now() + BETTING_DURATION_MS;
  table.statusMessage = 'Placez votre mise pour commencer';
  table.statusKind = '';
  dealerSay('Faites vos jeux, mesdames et messieurs.');
  broadcastState();
  await delay(BETTING_DURATION_MS);
}

async function dealingPhase(activeEntries) {
  table.phase = 'dealing';
  table.statusMessage = 'Distribution en cours…';
  broadcastState();

  const justReshuffled = reshuffleShoeIfNeeded();
  if (justReshuffled) {
    dealerSay('Nouveau sabot, mesdames et messieurs — on remélange !', 2400);
    toast('🂠 Nouveau sabot de 6 jeux mélangé');
    broadcastState();
    await delay(2500);
  }

  // Déduit la mise totale de chaque joueur concerné.
  const totalsByPlayer = new Map();
  for (const { playerId, handIndex } of activeEntries) {
    const hand = getPlayer(playerId).hands[handIndex];
    totalsByPlayer.set(playerId, (totalsByPlayer.get(playerId) || 0) + hand.bet);
  }
  for (const [playerId, total] of totalsByPlayer) {
    const rec = getOrCreatePlayerRecord(playerId);
    rec.bankroll = Math.max(0, rec.bankroll - total);
  }
  savePlayersDB();

  dealerSay('Les jeux sont faits, rien ne va plus.');

  // Distribution : chaque main reçoit une carte, deux tours, puis le croupier.
  for (let round = 0; round < 2; round++) {
    for (const { playerId, handIndex } of activeEntries) {
      const hand = getPlayer(playerId).hands[handIndex];
      hand.cards.push(drawCard());
      broadcastState();
      await delay(DEAL_STEP_MS);
    }
    table.dealerHand.push(drawCard());
    broadcastState();
    await delay(DEAL_STEP_MS);
  }

  activeEntries.forEach(({ playerId, handIndex }) => {
    getPlayer(playerId).hands[handIndex].state = 'playing';
  });

  table.statusMessage = 'Distribution terminée';
  broadcastState();
}

// `activeEntries` est la liste maîtresse (mutable) des mains en jeu pour la
// manche en cours ; `table.turnOrder` en est un sous-ensemble filtré qui
// partage les MÊMES références d'objets (issu d'un .filter()). Un split
// modifie donc les deux structures à la fois quand on touche `e.handIndex`.
async function playingPhase(activeEntries) {
  table.phase = 'playing';
  let i = 0;
  while (i < table.turnOrder.length) {
    const entry = table.turnOrder[i];
    const playerId = entry.playerId;
    const handIndex = entry.handIndex;
    const player = getPlayer(playerId);
    if (!player) { i++; continue; }
    let hand = player.hands[handIndex];
    if (!hand || hand.state === 'bust' || hand.state === 'blackjack' || hand.autoStood) { i++; continue; }

    // Une main issue d'un split peut totaliser 21 dès sa création (pas un
    // blackjack naturel) : elle reste automatiquement, comme un 21 obtenu
    // en tirant, sans qu'on lui redemande une action.
    if (hand.fromSplit && hand.cards.length === 2 && handValue(hand.cards).total === 21) {
      hand.state = 'stood';
      broadcastState();
      i++; continue;
    }

    table.activeTurn = { playerId, handIndex };
    table.statusMessage = `${player.name} joue sa main`;
    table.statusKind = '';
    broadcastState();

    let turnOver = false;
    while (!turnOver) {
      const action = await waitForPlayerAction(playerId, handIndex);
      hand = player.hands[handIndex];
      if (!hand) { turnOver = true; break; }

      if (action === 'hit') {
        hand.cards.push(drawCard());
        const { total } = handValue(hand.cards);
        broadcastState();
        if (total > 21) {
          hand.state = 'bust';
          turnOver = true;
        } else if (total === 21) {
          hand.state = 'stood';
          turnOver = true;
        }
      } else if (action === 'double') {
        const rec = getOrCreatePlayerRecord(playerId);
        if (hand.cards.length === 2 && rec.bankroll >= hand.bet) {
          rec.bankroll -= hand.bet;
          hand.bet *= 2;
          hand.doubled = true;
          savePlayersDB();
          hand.cards.push(drawCard());
          const { total } = handValue(hand.cards);
          hand.state = total > 21 ? 'bust' : 'stood';
          broadcastState();
          turnOver = true;
        }
        // mise insuffisante : on redemande une action (double refusé silencieusement)
      } else if (action === 'split') {
        const canSplit = hand.cards.length === 2
          && hand.cards[0].rank === hand.cards[1].rank
          && player.hands.length < MAX_HANDS_PER_PLAYER;
        const rec = getOrCreatePlayerRecord(playerId);
        if (canSplit && rec.bankroll >= hand.bet) {
          const isAceSplit = hand.cards[0].rank === 'A';
          const betAmount = hand.bet;
          rec.bankroll -= betAmount;
          savePlayersDB();

          const handA = {
            bet: betAmount, cards: [hand.cards[0], drawCard()],
            state: 'playing', result: null, payout: 0, doubled: false,
            fromSplit: true, autoStood: false,
          };
          const handB = {
            bet: betAmount, cards: [hand.cards[1], drawCard()],
            state: 'playing', result: null, payout: 0, doubled: false,
            fromSplit: true, autoStood: false,
          };

          if (isAceSplit) {
            // Split d'As : une seule carte chacune, puis reste imposé —
            // pas de tirer/doubler/re-split possible sur ces mains.
            handA.state = 'stood'; handA.autoStood = true;
            handB.state = 'stood'; handB.autoStood = true;
          }

          // Remplace la main d'origine par les deux nouvelles, à sa place.
          player.hands.splice(handIndex, 1, handA, handB);

          // Décale les index des autres mains de CE joueur situées après
          // la main splittée (toute la liste des mains de ce joueur a
          // grandi de 1 à partir de handIndex+1).
          for (const e of activeEntries) {
            if (e.playerId === playerId && e.handIndex > handIndex) e.handIndex += 1;
          }

          // Insère l'entrée de la seconde main juste après la main
          // courante dans l'ordre de jeu, pour qu'elle soit jouée juste
          // après (avant de passer au joueur suivant).
          const newEntry = { playerId, handIndex: handIndex + 1 };
          activeEntries.push(newEntry);
          table.turnOrder.splice(i + 1, 0, newEntry);

          hand = handA; // on continue de jouer la première moitié tout de suite
          broadcastState();

          if (hand.state !== 'stood' && handValue(hand.cards).total === 21) {
            hand.state = 'stood';
          }
          if (hand.state === 'stood') turnOver = true;
        }
        // split refusé (silencieusement) : paire invalide, limite de mains
        // atteinte ou solde insuffisant -> on redemande une action.
      } else {
        // 'stand' ou action inconnue -> on reste
        hand.state = 'stood';
        turnOver = true;
      }
    }
    broadcastState();
    await delay(300);
    i++;
  }
  table.activeTurn = null;
}

async function dealerPhase() {
  table.phase = 'dealer';
  table.dealerHoleRevealed = true;
  table.statusMessage = 'Le croupier joue…';
  table.statusKind = '';
  dealerSay('Le croupier retourne son jeu.');
  broadcastState();
  await delay(500);

  for (;;) {
    const { total } = handValue(table.dealerHand);
    if (total <= 16) {
      table.dealerHand.push(drawCard());
      broadcastState();
      await delay(DEALER_DRAW_MS);
    } else {
      break;
    }
  }
}

function resolveAllHands(activeEntries) {
  table.phase = 'resolved';
  table.dealerHoleRevealed = true;
  const dealer = handValue(table.dealerHand);
  const dealerBJ = isBlackjack(table.dealerHand);

  let anyWin = false, anyLose = false;

  for (const { playerId, handIndex } of activeEntries) {
    const player = getPlayer(playerId);
    if (!player) continue;
    const hand = player.hands[handIndex];
    if (!hand) continue;
    const playerVal = handValue(hand.cards);
    // Une main issue d'un split n'est jamais un blackjack naturel (paie 1:1
    // même à 21), y compris pour un split de deux As.
    const playerBJ = !hand.fromSplit && isBlackjack(hand.cards);

    let outcome, payout;
    if (playerBJ && dealerBJ) { outcome = 'push'; payout = hand.bet; }
    else if (playerBJ) { outcome = 'win'; payout = hand.bet + Math.floor(hand.bet * 1.5); }
    else if (dealerBJ) { outcome = 'lose'; payout = 0; }
    else if (playerVal.total > 21) { outcome = 'lose'; payout = 0; }
    else if (dealer.total > 21) { outcome = 'win'; payout = hand.bet * 2; }
    else if (playerVal.total > dealer.total) { outcome = 'win'; payout = hand.bet * 2; }
    else if (playerVal.total < dealer.total) { outcome = 'lose'; payout = 0; }
    else { outcome = 'push'; payout = hand.bet; }

    hand.result = outcome;
    hand.payout = payout;
    hand.state = outcome === 'lose' ? (hand.state === 'bust' ? 'bust' : 'lose') : hand.state;

    if (outcome === 'win') anyWin = true;
    if (outcome === 'lose') anyLose = true;

    const rec = getOrCreatePlayerRecord(playerId);
    rec.bankroll += payout;
    if (rec.bankroll <= 0) rec.bankroll = START_BANKROLL; // filet de sécurité, table amicale
  }
  savePlayersDB();

  if (anyWin && !anyLose) { table.statusMessage = 'La table l\'emporte !'; table.statusKind = 'win'; dealerSay('Bien joué, la table l\'emporte !'); }
  else if (anyLose && !anyWin) { table.statusMessage = 'La maison l\'emporte'; table.statusKind = 'lose'; dealerSay('La maison l\'emporte cette fois.'); }
  else { table.statusMessage = 'Manche terminée'; table.statusKind = 'push'; dealerSay('Manche terminée, on recompte les jetons.'); }
}

// Après un split, un groupe de mains adjacentes est marqué `fromSplit`.
// En fin de manche on réduit chaque groupe contigu à une seule main
// "propre", pour retrouver exactement le nombre de mains que le joueur
// avait choisi via "+ Ajouter une main" avant que le split ne les duplique.
function collapseSplitGroups(hands) {
  const result = [];
  let i = 0;
  while (i < hands.length) {
    if (hands[i].fromSplit) {
      while (i < hands.length && hands[i].fromSplit) i++;
      result.push(newHand());
    } else {
      result.push(hands[i]);
      i++;
    }
  }
  return result;
}

function resetForNextRound() {
  for (const player of players.values()) {
    if (player.hands.some((h) => h.fromSplit)) {
      player.hands = collapseSplitGroups(player.hands);
    }
    player.hands.forEach((hand) => {
      hand.bet = 0;
      hand.cards = [];
      hand.state = 'idle';
      hand.result = null;
      hand.payout = 0;
      hand.doubled = false;
      hand.fromSplit = false;
      hand.autoStood = false;
    });
  }
  table.dealerHand = [];
  table.dealerHoleRevealed = false;
  table.turnOrder = [];
  table.activeTurn = null;
}

// ---------- Connexions WebSocket ----------
function attachPlayerSocket(ws, playerId) {
  let player = getPlayer(playerId);
  if (!player) {
    player = { id: playerId, name: getOrCreatePlayerRecord(playerId).name, sockets: new Set(), hands: [newHand()] };
    players.set(playerId, player);
  }
  player.sockets.add(ws);
  ws.playerId = playerId;

  const rec = getOrCreatePlayerRecord(playerId);
  send(ws, { type: 'welcome', playerId, name: rec.name, bankroll: rec.bankroll });
  send(ws, serializeState());
}

function detachPlayerSocket(ws) {
  const player = getPlayer(ws.playerId);
  if (!player) return;
  player.sockets.delete(ws);
  broadcastState(); // met à jour le nombre de joueurs / statut connecté
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
      attachPlayerSocket(ws, playerId);
      broadcastState();
      return;
    }

    const playerId = ws.playerId;
    if (!playerId) return; // pas encore identifié
    const player = getPlayer(playerId);
    if (!player) return;

    switch (msg.type) {
      case 'addHand': {
        if (table.phase !== 'betting') return;
        if (player.hands.length >= MAX_HANDS_PER_PLAYER) return;
        player.hands.push(newHand());
        broadcastState();
        break;
      }
      case 'removeHand': {
        if (table.phase !== 'betting') return;
        const idx = msg.handIndex;
        if (player.hands.length <= 1) return;
        if (idx < 0 || idx >= player.hands.length) return;
        player.hands.splice(idx, 1);
        broadcastState();
        break;
      }
      case 'bet': {
        if (table.phase !== 'betting') return;
        const idx = msg.handIndex;
        const amount = Number(msg.amount);
        if (!Number.isFinite(amount) || amount <= 0) return;
        if (idx < 0 || idx >= player.hands.length) return;
        const rec = getOrCreatePlayerRecord(playerId);
        const totalBet = player.hands.reduce((s, h) => s + h.bet, 0);
        if (totalBet + amount > rec.bankroll) return; // fonds insuffisants
        player.hands[idx].bet += amount;
        broadcastState();
        break;
      }
      case 'clearBet': {
        if (table.phase !== 'betting') return;
        const idx = msg.handIndex;
        if (idx < 0 || idx >= player.hands.length) return;
        player.hands[idx].bet = 0;
        broadcastState();
        break;
      }
      case 'hit':
      case 'stand':
      case 'double':
      case 'split': {
        if (table.phase !== 'playing') return;
        if (!table.activeTurn || table.activeTurn.playerId !== playerId) return;
        submitAction(playerId, table.activeTurn.handIndex, msg.type);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => detachPlayerSocket(ws));
  ws.on('error', () => detachPlayerSocket(ws));
});

// Heartbeat : ferme les sockets mortes pour garder la liste "connecté" propre.
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
  if (req.url && req.url.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ---------- Démarrage ----------
loadPlayersDB();
shoe = buildShoe();
server.listen(PORT, () => {
  console.log(`Table de Blackjack partagée en écoute sur le port ${PORT}`);
  console.log(`HTTP : http://localhost:${PORT}  —  WebSocket : ws://localhost:${PORT}/ws`);
});

runTableLoop().catch((err) => {
  console.error('Erreur fatale dans la boucle de table :', err);
  process.exit(1);
});
