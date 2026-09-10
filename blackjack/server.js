'use strict';

/* ============================================================
   BLACKJACK — serveur multi-tables
   ------------------------------------------------------------
   Un seul serveur Node (Express pour servir les fichiers statiques
   + ws pour le websocket, sur UN SEUL port) fait autorité sur :
     - une table PUBLIQUE par défaut, toujours active
     - un nombre variable de tables PRIVÉES, créées à la demande et
       identifiées par un code court, chacune avec son propre sabot,
       ses propres mises/mains et son propre minuteur — totalement
       indépendantes les unes des autres
     - les soldes de jetons de chaque joueur (persistés sur disque),
       qui eux restent globaux : un joueur garde le même solde en
       changeant de table, seule la partie en cours est isolée
   Chaque table fait tourner sa propre boucle de manches (mise ->
   distribution -> tours -> croupier -> résolution). Tous les clients
   connectés à une même table voient le même sabot et les mêmes cartes
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
const BETTING_DURATION_MS = Number(process.env.BETTING_DURATION_MS) || 22000;   // durée max de la phase de mise
const FAST_START_DELAY_MS = Number(process.env.FAST_START_DELAY_MS) || 1500;    // délai de sécurité une fois tout le monde prêt
const PAUSE_AFTER_ROUND_MS = Number(process.env.PAUSE_AFTER_ROUND_MS) || 5000;  // pause avant la manche suivante
const EMPTY_ROUND_PAUSE_MS = Number(process.env.EMPTY_ROUND_PAUSE_MS) || 3000;  // pause si personne n'a misé
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS) || 18000;           // temps max pour jouer une main avant "Rester" auto
const DEAL_STEP_MS = 260;
const DEALER_DRAW_MS = 650;

const PUBLIC_TABLE_CODE = 'PUBLIC';
const TABLE_CODE_LENGTH = 6;
// Alphabet sans caractères ambigus (pas de 0/O, 1/I/L) pour rester
// facilement lisible/dictable à des potes.
const TABLE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PRIVATE_TABLE_IDLE_CLEANUP_MS = Number(process.env.PRIVATE_TABLE_IDLE_CLEANUP_MS) || 15 * 60 * 1000;
const TABLE_CLEANUP_INTERVAL_MS = 60 * 1000;

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

// ---------- Persistance des soldes (globale, partagée entre toutes les tables) ----------
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

function generateTableCode() {
  let code = '';
  for (let i = 0; i < TABLE_CODE_LENGTH; i++) {
    code += TABLE_CODE_ALPHABET[secureRandomInt(TABLE_CODE_ALPHABET.length)];
  }
  return code;
}

function generateUniqueTableCode() {
  let code;
  do {
    code = generateTableCode();
  } while (tables.has(code) || code === PUBLIC_TABLE_CODE);
  return code;
}

// Nettoie un code fourni par un client (URL / message) : lettres/chiffres
// uniquement, majuscules, longueur bornée. Un code vide ou invalide retombe
// sur la table publique.
function sanitizeTableCode(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!cleaned || cleaned === PUBLIC_TABLE_CODE) return null;
  return cleaned;
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

function buildShoe() {
  const deck = shuffle(buildFreshDecks(NUM_DECKS));
  const cutCardIndex = Math.floor(deck.length * (1 - CUT_PENETRATION));
  return { deck, cutCardIndex };
}

function drawCard(t) {
  if (t.shoe.length === 0) {
    const fresh = buildShoe();
    t.shoe = fresh.deck;
    t.cutCardIndex = fresh.cutCardIndex;
    t.needsReshuffle = false;
  }
  const card = t.shoe.pop();
  if (t.shoe.length <= t.cutCardIndex) t.needsReshuffle = true;
  return card;
}

function reshuffleShoeIfNeeded(t) {
  if (!t.needsReshuffle) return false;
  const fresh = buildShoe();
  t.shoe = fresh.deck;
  t.cutCardIndex = fresh.cutCardIndex;
  t.needsReshuffle = false;
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

function newHand() {
  return { bet: 0, cards: [], state: 'idle', result: null, payout: 0 };
}

// ---------- Table : état + registre ----------
// Chaque table possède son propre état complet (sabot, joueurs, mises,
// minuteur…), totalement indépendant des autres. `tables` indexe toutes les
// tables actives par leur code ; la table publique y est toujours présente.
const tables = new Map(); // code -> tableState

function createTableState(code, isPublic) {
  const fresh = buildShoe();
  return {
    code,
    isPublic,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    stopped: false,

    // players : Map(playerId -> { id, name, sockets:Set<ws>, hands:[Hand] })
    players: new Map(),

    // Sabot
    shoe: fresh.deck,
    cutCardIndex: fresh.cutCardIndex,
    needsReshuffle: false,

    // Table / manche en cours
    table: {
      phase: 'betting', // betting | dealing | playing | dealer | resolved
      bettingEndsAt: Date.now() + BETTING_DURATION_MS,
      dealerHand: [],
      dealerHoleRevealed: false,
      turnOrder: [],     // [{ playerId, handIndex }]
      activeTurn: null,  // { playerId, handIndex }
      statusMessage: 'Placez votre mise pour commencer',
      statusKind: '',
    },

    // Gestion du tour du joueur actif
    currentTurnResolver: null,
    currentTurnTimer: null,
    currentTurnKey: null, // `${playerId}:${handIndex}`

    // Démarrage accéléré de la phase de mise
    bettingResolve: null,
    bettingDeadlineTimer: null,
    bettingFastTimer: null,
  };
}

function getOrCreateTable(code) {
  let t = tables.get(code);
  if (!t) {
    t = createTableState(code, code === PUBLIC_TABLE_CODE);
    tables.set(code, t);
    runTableLoop(t).catch((err) => {
      console.error(`Erreur fatale dans la boucle de la table ${code} :`, err);
    });
  }
  return t;
}

function touchTableActivity(t) {
  t.lastActivityAt = Date.now();
}

function getPlayer(t, playerId) {
  return t.players.get(playerId);
}

function countConnectedPlayers(t) {
  let n = 0;
  for (const p of t.players.values()) if (p.sockets.size > 0) n++;
  return n;
}

// ---------- WebSocket : envoi ----------
const wss = new WebSocketServer({ noServer: true });

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }
}

// Diffuse uniquement aux joueurs connectés à CETTE table (isolation stricte
// entre tables : personne ne voit ni n'influence une table qui n'est pas la
// sienne).
function broadcast(t, payload) {
  const raw = JSON.stringify(payload);
  for (const player of t.players.values()) {
    for (const client of player.sockets) {
      if (client.readyState === client.OPEN) client.send(raw);
    }
  }
}

function serializeCard(card, hidden) {
  if (hidden) return { hidden: true };
  return { rank: card.rank, suit: card.suit, symbol: card.symbol, color: card.color };
}

function serializeState(t) {
  return {
    type: 'state',
    tableCode: t.code,
    isPublicTable: t.isPublic,
    phase: t.table.phase,
    bettingEndsAt: t.table.bettingEndsAt,
    statusMessage: t.table.statusMessage,
    statusKind: t.table.statusKind,
    dealer: {
      cards: t.table.dealerHand.map((c, i) => serializeCard(c, i === 1 && !t.table.dealerHoleRevealed)),
      holeRevealed: t.table.dealerHoleRevealed,
      total: t.table.dealerHoleRevealed ? handValue(t.table.dealerHand).total : null,
      isSoft: t.table.dealerHoleRevealed ? handValue(t.table.dealerHand).isSoft : false,
      isBlackjack: t.table.dealerHand.length === 2 && isBlackjack(t.table.dealerHand),
    },
    activeTurn: t.table.activeTurn,
    playersCount: t.players.size,
    players: Array.from(t.players.values()).map((p) => ({
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
      remaining: t.shoe.length,
      total: SHOE_SIZE,
      cutCardIndex: t.cutCardIndex,
    },
  };
}

function broadcastState(t) {
  broadcast(t, serializeState(t));
}

function dealerSay(t, text, duration = 2600) {
  broadcast(t, { type: 'dealerSay', text, duration });
}

function toast(t, text) {
  broadcast(t, { type: 'toast', text });
}

// ---------- Utilitaires ----------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Actions des joueurs pendant leur tour ----------
function waitForPlayerAction(t, playerId, handIndex) {
  t.currentTurnKey = `${playerId}:${handIndex}`;
  return new Promise((resolve) => {
    t.currentTurnResolver = (action) => {
      clearTimeout(t.currentTurnTimer);
      t.currentTurnResolver = null;
      t.currentTurnKey = null;
      resolve(action);
    };
    t.currentTurnTimer = setTimeout(() => {
      if (t.currentTurnResolver) {
        const r = t.currentTurnResolver;
        t.currentTurnResolver = null;
        t.currentTurnKey = null;
        r('stand');
      }
    }, TURN_TIMEOUT_MS);
  });
}

function submitAction(t, playerId, handIndex, action) {
  const key = `${playerId}:${handIndex}`;
  if (t.currentTurnKey === key && t.currentTurnResolver) {
    t.currentTurnResolver(action);
  }
}

// ---------- Démarrage accéléré de la phase de mise ----------
// Renvoie true si le joueur est "engagé" (au moins une main misée) et a
// misé sur TOUTES ses mains ; false s'il est engagé mais pas complet ;
// null s'il n'est pas engagé du tout (ne bloque ni ne déclenche rien).
function playerBettingReadiness(player) {
  const engagedHands = player.hands.filter((h) => h.bet > 0);
  if (engagedHands.length === 0) return null;
  return engagedHands.length === player.hands.length;
}

// Vrai si tous les joueurs CONNECTÉS et engagés dans la manche ont misé sur
// toutes leurs mains, et qu'il y a au moins un joueur engagé (sinon la
// manche serait vide, pas de raison d'accélérer).
function allEngagedPlayersReady(t) {
  let anyEngaged = false;
  for (const player of t.players.values()) {
    if (player.sockets.size === 0) continue; // seuls les joueurs connectés comptent
    const readiness = playerBettingReadiness(player);
    if (readiness === null) continue; // pas engagé, ne bloque pas
    anyEngaged = true;
    if (readiness === false) return false;
  }
  return anyEngaged;
}

// Termine immédiatement la phase de mise en cours (appelé par le minuteur
// normal ou par le démarrage accéléré).
function finishBetting(t) {
  if (!t.bettingResolve) return;
  clearTimeout(t.bettingDeadlineTimer);
  clearTimeout(t.bettingFastTimer);
  t.bettingDeadlineTimer = null;
  t.bettingFastTimer = null;
  const resolve = t.bettingResolve;
  t.bettingResolve = null;
  resolve();
}

// À appeler après toute action susceptible de changer si "tout le monde a
// misé" (mise, effacement, ajout/retrait de main, connexion/déconnexion).
// Démarre ou annule le petit délai de sécurité accéléré en conséquence.
function scheduleFastStartCheck(t) {
  if (t.table.phase !== 'betting' || !t.bettingResolve) return;
  const ready = allEngagedPlayersReady(t);
  if (ready) {
    if (!t.bettingFastTimer) {
      t.bettingFastTimer = setTimeout(() => finishBetting(t), FAST_START_DELAY_MS);
    }
  } else if (t.bettingFastTimer) {
    clearTimeout(t.bettingFastTimer);
    t.bettingFastTimer = null;
  }
}

// Un joueur qui rejoint la table pendant un compte à rebours accéléré doit
// avoir le temps normal de miser : on annule le démarrage accéléré en cours
// (il repartira de lui-même via scheduleFastStartCheck si tout le monde,
// nouveau venu inclus, finit par miser).
function cancelFastStart(t) {
  if (t.bettingFastTimer) {
    clearTimeout(t.bettingFastTimer);
    t.bettingFastTimer = null;
  }
}

// ---------- Boucle principale d'une table ----------
async function runTableLoop(t) {
  for (;;) {
    if (t.stopped) return;
    await bettingPhase(t);
    if (t.stopped) return;
    const activeEntries = collectActiveHands(t);
    if (activeEntries.length === 0) {
      t.table.statusMessage = 'Personne n\'a misé — nouvelle manche';
      t.table.statusKind = '';
      broadcastState(t);
      await delay(EMPTY_ROUND_PAUSE_MS);
      continue;
    }
    await dealingPhase(t, activeEntries);

    const dealerBJ = isBlackjack(t.table.dealerHand);
    if (dealerBJ) {
      t.table.dealerHoleRevealed = true;
      dealerSay(t, 'Blackjack pour la maison.');
      resolveAllHands(t, activeEntries);
    } else {
      t.table.turnOrder = activeEntries.filter(({ playerId, handIndex }) => {
        const hand = getPlayer(t, playerId).hands[handIndex];
        return !isBlackjack(hand.cards);
      });
      // Les mains blackjack du joueur restent en attente, sans jouer.
      activeEntries.forEach(({ playerId, handIndex }) => {
        const hand = getPlayer(t, playerId).hands[handIndex];
        if (isBlackjack(hand.cards)) hand.state = 'blackjack';
      });
      await playingPhase(t, activeEntries);
      await dealerPhase(t);
      resolveAllHands(t, activeEntries);
    }

    broadcastState(t);
    await delay(PAUSE_AFTER_ROUND_MS);
    resetForNextRound(t);
  }
}

function collectActiveHands(t) {
  const entries = [];
  for (const player of t.players.values()) {
    player.hands.forEach((hand, handIndex) => {
      if (hand.bet > 0) entries.push({ playerId: player.id, handIndex });
    });
  }
  return entries;
}

async function bettingPhase(t) {
  t.table.phase = 'betting';
  t.table.dealerHand = [];
  t.table.dealerHoleRevealed = false;
  t.table.turnOrder = [];
  t.table.activeTurn = null;
  t.table.bettingEndsAt = Date.now() + BETTING_DURATION_MS;
  t.table.statusMessage = 'Placez votre mise pour commencer';
  t.table.statusKind = '';
  dealerSay(t, 'Faites vos jeux, mesdames et messieurs.');
  broadcastState(t);

  await new Promise((resolve) => {
    t.bettingResolve = resolve;
    t.bettingDeadlineTimer = setTimeout(() => finishBetting(t), BETTING_DURATION_MS);
    // Cas table à un seul joueur (ou tous déjà prêts dès l'ouverture, rare
    // mais possible juste après un reset) : vérifie immédiatement.
    scheduleFastStartCheck(t);
  });
}

async function dealingPhase(t, activeEntries) {
  t.table.phase = 'dealing';
  t.table.statusMessage = 'Distribution en cours…';
  broadcastState(t);

  const justReshuffled = reshuffleShoeIfNeeded(t);
  if (justReshuffled) {
    dealerSay(t, 'Nouveau sabot, mesdames et messieurs — on remélange !', 2400);
    toast(t, '🂠 Nouveau sabot de 6 jeux mélangé');
    broadcastState(t);
    await delay(2500);
  }

  // Déduit la mise totale de chaque joueur concerné.
  const totalsByPlayer = new Map();
  for (const { playerId, handIndex } of activeEntries) {
    const hand = getPlayer(t, playerId).hands[handIndex];
    totalsByPlayer.set(playerId, (totalsByPlayer.get(playerId) || 0) + hand.bet);
  }
  for (const [playerId, total] of totalsByPlayer) {
    const rec = getOrCreatePlayerRecord(playerId);
    rec.bankroll = Math.max(0, rec.bankroll - total);
  }
  savePlayersDB();

  dealerSay(t, 'Les jeux sont faits, rien ne va plus.');

  // Distribution : chaque main reçoit une carte, deux tours, puis le croupier.
  for (let round = 0; round < 2; round++) {
    for (const { playerId, handIndex } of activeEntries) {
      const hand = getPlayer(t, playerId).hands[handIndex];
      hand.cards.push(drawCard(t));
      broadcastState(t);
      await delay(DEAL_STEP_MS);
    }
    t.table.dealerHand.push(drawCard(t));
    broadcastState(t);
    await delay(DEAL_STEP_MS);
  }

  activeEntries.forEach(({ playerId, handIndex }) => {
    getPlayer(t, playerId).hands[handIndex].state = 'playing';
  });

  t.table.statusMessage = 'Distribution terminée';
  broadcastState(t);
}

// `activeEntries` est la liste maîtresse (mutable) des mains en jeu pour la
// manche en cours ; `t.table.turnOrder` en est un sous-ensemble filtré qui
// partage les MÊMES références d'objets (issu d'un .filter()). Un split
// modifie donc les deux structures à la fois quand on touche `e.handIndex`.
async function playingPhase(t, activeEntries) {
  t.table.phase = 'playing';
  let i = 0;
  while (i < t.table.turnOrder.length) {
    const entry = t.table.turnOrder[i];
    const playerId = entry.playerId;
    const handIndex = entry.handIndex;
    const player = getPlayer(t, playerId);
    if (!player) { i++; continue; }
    let hand = player.hands[handIndex];
    if (!hand || hand.state === 'bust' || hand.state === 'blackjack' || hand.autoStood) { i++; continue; }

    // Une main issue d'un split peut totaliser 21 dès sa création (pas un
    // blackjack naturel) : elle reste automatiquement, comme un 21 obtenu
    // en tirant, sans qu'on lui redemande une action.
    if (hand.fromSplit && hand.cards.length === 2 && handValue(hand.cards).total === 21) {
      hand.state = 'stood';
      broadcastState(t);
      i++; continue;
    }

    t.table.activeTurn = { playerId, handIndex };
    t.table.statusMessage = `${player.name} joue sa main`;
    t.table.statusKind = '';
    broadcastState(t);

    let turnOver = false;
    while (!turnOver) {
      const action = await waitForPlayerAction(t, playerId, handIndex);
      hand = player.hands[handIndex];
      if (!hand) { turnOver = true; break; }

      if (action === 'hit') {
        hand.cards.push(drawCard(t));
        const { total } = handValue(hand.cards);
        broadcastState(t);
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
          hand.cards.push(drawCard(t));
          const { total } = handValue(hand.cards);
          hand.state = total > 21 ? 'bust' : 'stood';
          broadcastState(t);
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
            bet: betAmount, cards: [hand.cards[0], drawCard(t)],
            state: 'playing', result: null, payout: 0, doubled: false,
            fromSplit: true, autoStood: false,
          };
          const handB = {
            bet: betAmount, cards: [hand.cards[1], drawCard(t)],
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
          t.table.turnOrder.splice(i + 1, 0, newEntry);

          hand = handA; // on continue de jouer la première moitié tout de suite
          broadcastState(t);

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
    broadcastState(t);
    await delay(300);
    i++;
  }
  t.table.activeTurn = null;
}

async function dealerPhase(t) {
  t.table.phase = 'dealer';
  t.table.dealerHoleRevealed = true;
  t.table.statusMessage = 'Le croupier joue…';
  t.table.statusKind = '';
  dealerSay(t, 'Le croupier retourne son jeu.');
  broadcastState(t);
  await delay(500);

  for (;;) {
    const { total } = handValue(t.table.dealerHand);
    if (total <= 16) {
      t.table.dealerHand.push(drawCard(t));
      broadcastState(t);
      await delay(DEALER_DRAW_MS);
    } else {
      break;
    }
  }
}

function resolveAllHands(t, activeEntries) {
  t.table.phase = 'resolved';
  t.table.dealerHoleRevealed = true;
  const dealer = handValue(t.table.dealerHand);
  const dealerBJ = isBlackjack(t.table.dealerHand);

  let anyWin = false, anyLose = false;

  for (const { playerId, handIndex } of activeEntries) {
    const player = getPlayer(t, playerId);
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

  if (anyWin && !anyLose) { t.table.statusMessage = 'La table l\'emporte !'; t.table.statusKind = 'win'; dealerSay(t, 'Bien joué, la table l\'emporte !'); }
  else if (anyLose && !anyWin) { t.table.statusMessage = 'La maison l\'emporte'; t.table.statusKind = 'lose'; dealerSay(t, 'La maison l\'emporte cette fois.'); }
  else { t.table.statusMessage = 'Manche terminée'; t.table.statusKind = 'push'; dealerSay(t, 'Manche terminée, on recompte les jetons.'); }
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

function resetForNextRound(t) {
  for (const player of t.players.values()) {
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
  t.table.dealerHand = [];
  t.table.dealerHoleRevealed = false;
  t.table.turnOrder = [];
  t.table.activeTurn = null;
}

// ---------- Connexions WebSocket ----------
function attachPlayerSocket(t, ws, playerId) {
  let player = getPlayer(t, playerId);
  if (!player) {
    player = { id: playerId, name: getOrCreatePlayerRecord(playerId).name, sockets: new Set(), hands: [newHand()] };
    t.players.set(playerId, player);
  }
  player.sockets.add(ws);
  ws.playerId = playerId;
  ws.tableCode = t.code;
  touchTableActivity(t);

  // Un nouveau venu doit avoir le temps normal de miser : on annule un
  // éventuel démarrage accéléré déjà programmé (repartira tout seul si tout
  // le monde, lui inclus, finit par miser).
  cancelFastStart(t);

  const rec = getOrCreatePlayerRecord(playerId);
  send(ws, {
    type: 'welcome',
    playerId,
    name: rec.name,
    bankroll: rec.bankroll,
    tableCode: t.code,
    isPublicTable: t.isPublic,
  });
  send(ws, serializeState(t));
}

function detachPlayerSocket(t, ws) {
  const player = getPlayer(t, ws.playerId);
  if (!player) return;
  player.sockets.delete(ws);
  touchTableActivity(t);
  broadcastState(t); // met à jour le nombre de joueurs / statut connecté
  scheduleFastStartCheck(t); // un départ peut rendre la table "prête"
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
      const code = sanitizeTableCode(msg.tableCode) || PUBLIC_TABLE_CODE;
      const t = getOrCreateTable(code);
      ws.table = t;
      attachPlayerSocket(t, ws, playerId);
      broadcastState(t);
      return;
    }

    // Toute action ultérieure s'applique à la table sur laquelle ce socket
    // s'est identifié via "hello".
    const t = ws.table;
    if (!t) return; // pas encore identifié
    const playerId = ws.playerId;
    if (!playerId) return;
    const player = getPlayer(t, playerId);
    if (!player) return;

    switch (msg.type) {
      case 'createTable': {
        // Demande explicite d'une NOUVELLE table privée : génère un code
        // inédit et le renvoie au client, qui rejoindra ensuite cette table
        // (le client reconnecte avec ce code, comme pour "rejoindre").
        const code = generateUniqueTableCode();
        send(ws, { type: 'tableCreated', tableCode: code });
        break;
      }
      case 'addHand': {
        if (t.table.phase !== 'betting') return;
        if (player.hands.length >= MAX_HANDS_PER_PLAYER) return;
        player.hands.push(newHand());
        touchTableActivity(t);
        broadcastState(t);
        scheduleFastStartCheck(t);
        break;
      }
      case 'removeHand': {
        if (t.table.phase !== 'betting') return;
        const idx = msg.handIndex;
        if (player.hands.length <= 1) return;
        if (idx < 0 || idx >= player.hands.length) return;
        player.hands.splice(idx, 1);
        touchTableActivity(t);
        broadcastState(t);
        scheduleFastStartCheck(t);
        break;
      }
      case 'bet': {
        if (t.table.phase !== 'betting') return;
        const idx = msg.handIndex;
        const amount = Number(msg.amount);
        if (!Number.isFinite(amount) || amount <= 0) return;
        if (idx < 0 || idx >= player.hands.length) return;
        const rec = getOrCreatePlayerRecord(playerId);
        const totalBet = player.hands.reduce((s, h) => s + h.bet, 0);
        if (totalBet + amount > rec.bankroll) return; // fonds insuffisants
        player.hands[idx].bet += amount;
        touchTableActivity(t);
        broadcastState(t);
        scheduleFastStartCheck(t);
        break;
      }
      case 'clearBet': {
        if (t.table.phase !== 'betting') return;
        const idx = msg.handIndex;
        if (idx < 0 || idx >= player.hands.length) return;
        player.hands[idx].bet = 0;
        touchTableActivity(t);
        broadcastState(t);
        scheduleFastStartCheck(t);
        break;
      }
      case 'hit':
      case 'stand':
      case 'double':
      case 'split': {
        if (t.table.phase !== 'playing') return;
        if (!t.table.activeTurn || t.table.activeTurn.playerId !== playerId) return;
        touchTableActivity(t);
        submitAction(t, playerId, t.table.activeTurn.handIndex, msg.type);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => { if (ws.table) detachPlayerSocket(ws.table, ws); });
  ws.on('error', () => { if (ws.table) detachPlayerSocket(ws.table, ws); });
});

// Heartbeat : ferme les sockets mortes pour garder la liste "connecté" propre.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

// ---------- Nettoyage des tables privées inactives ----------
// Une table privée sans aucun joueur connecté depuis un moment est détruite
// pour libérer la mémoire (sa boucle se termine d'elle-même au prochain tour
// grâce au flag `stopped`). La table publique n'est jamais nettoyée.
setInterval(() => {
  const now = Date.now();
  for (const [code, t] of tables) {
    if (t.isPublic) continue;
    if (countConnectedPlayers(t) > 0) continue;
    if (now - t.lastActivityAt < PRIVATE_TABLE_IDLE_CLEANUP_MS) continue;
    t.stopped = true;
    clearTimeout(t.bettingDeadlineTimer);
    clearTimeout(t.bettingFastTimer);
    clearTimeout(t.currentTurnTimer);
    tables.delete(code);
  }
}, TABLE_CLEANUP_INTERVAL_MS);

// ---------- Serveur HTTP + fichiers statiques ----------
const app = express();
app.use(express.static(__dirname, { extensions: ['html'] }));

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  // On accepte toute requête d'upgrade se terminant par "/ws", pas seulement
  // "/ws" à la racine : selon la config du reverse proxy (nginx), un
  // déploiement sous un sous-chemin (ex. /blackjack/) peut soit conserver
  // ce préfixe jusqu'ici, soit le retirer avant de transmettre au backend.
  // Le client (script.js) construit toujours son URL de façon relative à
  // son propre chemin, donc les deux cas sont couverts. Le code de table
  // n'est PAS transmis dans l'URL/la query string (pour rester robuste face
  // à un proxy qui la retirerait) : le client l'envoie dans le message
  // "hello" juste après l'ouverture du socket.
  const url = (req.url || '').split('?')[0];
  if (url === '/ws' || url.endsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ---------- Démarrage ----------
loadPlayersDB();
getOrCreateTable(PUBLIC_TABLE_CODE); // la table publique est toujours active
server.listen(PORT, () => {
  console.log(`Blackjack (multi-tables) en écoute sur le port ${PORT}`);
  console.log(`HTTP : http://localhost:${PORT}  —  WebSocket : ws://localhost:${PORT}/ws`);
});
