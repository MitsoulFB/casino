'use strict';

/* ============================================================
   ROULETTE — serveur table partagée
   ------------------------------------------------------------
   Un seul serveur Node (Express pour servir les fichiers statiques
   + ws pour le websocket, sur UN SEUL port) fait autorité sur :
     - la table PUBLIQUE unique (pas de tables privées, contrairement
       au blackjack : la roulette reste volontairement simple)
     - le tirage du numéro gagnant (crypto-aléatoire, déplacé ici
       depuis le client)
     - la phase de mise chronométrée, commune à tous les joueurs
       connectés : ils misent tous sur le même tapis, en même temps
     - le lancement de la roue, simultané pour tout le monde (même
       numéro gagnant diffusé à tous)
     - la résolution des gains/pertes, indépendante par joueur
     - les soldes de jetons de chaque joueur, persistés sur disque
   Boucle de la table : mise -> lancer -> résolution -> pause -> mise…
   ============================================================ */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

// ---------- Configuration ----------
const PORT = process.env.PORT || 3034;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');

const START_BANKROLL = 1000;
// Durées configurables via variables d'environnement (utile pour les tests).
const BETTING_DURATION_MS = Number(process.env.BETTING_DURATION_MS) || 20000; // durée max de la phase de mise
const FAST_START_DELAY_MS = Number(process.env.FAST_START_DELAY_MS) || 1500;  // délai de sécurité une fois tout le monde prêt
const SPIN_DURATION_MS = Number(process.env.SPIN_DURATION_MS) || 4900;        // doit couvrir l'animation CSS côté client (4.6s)
const RESULT_PAUSE_MS = Number(process.env.RESULT_PAUSE_MS) || 6000;          // pause d'affichage des résultats avant la manche suivante
const EMPTY_ROUND_PAUSE_MS = Number(process.env.EMPTY_ROUND_PAUSE_MS) || 3000; // pause si personne n'a misé

const ALLOWED_CHIP_VALUES = new Set([5, 25, 100, 500]);
const MAX_NAME_LENGTH = 18;
const LEADERBOARD_SIZE = 10; // taille du top affiché (tous les joueurs connus si moins nombreux)

// ---------- Persistance des soldes ----------
// { [playerId]: { name, bankroll, record } }
let playersDB = {};

function loadPlayersDB() {
  try {
    const raw = fs.readFileSync(PLAYERS_FILE, 'utf8');
    playersDB = JSON.parse(raw);
  } catch {
    playersDB = {};
  }
  // Migration douce : les entrées enregistrées avant l'ajout du classement
  // n'ont pas de champ "record" (plus haut solde de jetons jamais atteint).
  // On l'initialise au solde actuel — la meilleure estimation possible sans
  // historique — plutôt que de planter ou d'ignorer ces joueurs. Idem pour
  // un éventuel champ "name" manquant/corrompu.
  for (const id of Object.keys(playersDB)) {
    const rec = playersDB[id];
    if (!rec || typeof rec !== 'object') { delete playersDB[id]; continue; }
    if (!Number.isFinite(rec.bankroll)) rec.bankroll = START_BANKROLL;
    if (!Number.isFinite(rec.record) || rec.record < rec.bankroll) {
      rec.record = Number.isFinite(rec.record) ? Math.max(rec.record, rec.bankroll) : rec.bankroll;
    }
    if (typeof rec.name !== 'string' || !rec.name.trim()) rec.name = randomName();
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
    playersDB[playerId] = { name: randomName(), bankroll: START_BANKROLL, record: START_BANKROLL };
    savePlayersDB();
  }
  return playersDB[playerId];
}

// Change le solde d'un joueur et met à jour, si besoin, son record personnel
// (le solde de jetons le plus élevé jamais atteint). Centralise TOUTE
// modification de bankroll pour que le record soit toujours à jour, pas
// seulement en fin de manche (voir spinPhase / resolveRound).
function setBankroll(rec, newBankroll) {
  rec.bankroll = newBankroll;
  if (!Number.isFinite(rec.record) || rec.bankroll > rec.record) {
    rec.record = rec.bankroll;
  }
}

// Classement global (tous les joueurs connus du serveur) par record de
// jetons décroissant.
function buildLeaderboard() {
  return Object.entries(playersDB)
    .map(([id, rec]) => ({
      id,
      name: rec.name || 'Joueur',
      record: Number.isFinite(rec.record) ? rec.record : (Number.isFinite(rec.bankroll) ? rec.bankroll : START_BANKROLL),
    }))
    .sort((a, b) => b.record - a.record)
    .slice(0, LEADERBOARD_SIZE);
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return cleaned || null;
}

// ---------- Générateur aléatoire cryptographique ----------
function secureRandomInt(maxExclusive) {
  return crypto.randomInt(maxExclusive);
}

// ---------- Règles de la roulette (identiques à la version solo, déplacées ici) ----------
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const POCKET_COUNT = 37; // 0 à 36
const HISTORY_MAX = 12;

function numberColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

function betNums(betId) {
  // Pour les mises composites (split-a-b, corner-a-b-c-d, street-a-b-c),
  // les numéros couverts sont encodés dans l'id, triés par ordre croissant.
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
function betMultiplier(betId) {
  if (betId.startsWith('straight-')) return 36; // 35:1 + mise rendue
  if (betId.startsWith('split-')) return 18;     // 17:1 + mise rendue
  if (betId.startsWith('street-')) return 12;    // 11:1 + mise rendue
  if (betId.startsWith('corner-')) return 9;     //  8:1 + mise rendue
  if (['dozen-1', 'dozen-2', 'dozen-3', 'col-1', 'col-2', 'col-3'].includes(betId)) return 3; // 2:1 + mise
  return 2; // chances simples 1:1 + mise
}

function announceResult(n) {
  if (n === 0) return '0, zéro.';
  const color = numberColor(n);
  const colorFr = color === 'red' ? 'rouge' : 'noir';
  const parity = n % 2 === 0 ? 'pair' : 'impair';
  const range = n <= 18 ? 'manque' : 'passe';
  return `${n}, ${colorFr}, ${parity}, ${range}.`;
}

// ---------- Construction des identifiants de mise valides ----------
// Reprend exactement la géométrie du tapis (script.js, buildHotspotDefs) —
// fonction pure, sans DOM — pour connaître côté serveur l'ensemble des
// mises à cheval / carré légales, et rejeter tout betId inconnu.
function buildValidBetIds() {
  const ids = new Set();
  for (let n = 0; n <= 36; n++) ids.add(`straight-${n}`);
  ['dozen-1', 'dozen-2', 'dozen-3', 'col-1', 'col-2', 'col-3', 'red', 'black', 'even', 'odd', 'low', 'high']
    .forEach((id) => ids.add(id));

  function addSplit(a, b) {
    const nums = [a, b].sort((x, y) => x - y);
    ids.add(`split-${nums.join('-')}`);
  }
  function addCorner(topLeft, topRight, botLeft, botRight) {
    const nums = [topLeft, topRight, botLeft, botRight].sort((x, y) => x - y);
    ids.add(`corner-${nums.join('-')}`);
  }

  for (let c = 1; c <= 12; c++) {
    const top = 3 * c, mid = 3 * c - 1, bot = 3 * c - 2;
    addSplit(top, mid);
    addSplit(mid, bot);
    ids.add(`street-${[bot, mid, top].sort((x, y) => x - y).join('-')}`);
    if (c < 12) {
      const top2 = 3 * (c + 1), mid2 = 3 * (c + 1) - 1, bot2 = 3 * (c + 1) - 2;
      addSplit(top, top2);
      addSplit(mid, mid2);
      addSplit(bot, bot2);
      addCorner(top, top2, mid, mid2);
      addCorner(mid, mid2, bot, bot2);
    }
  }
  // Mises à cheval avec le zéro (0-1, 0-2, 0-3)
  addSplit(0, 1);
  addSplit(0, 2);
  addSplit(0, 3);

  return ids;
}
const VALID_BET_IDS = buildValidBetIds();

// ---------- État de la table (unique, publique) ----------
const table = {
  phase: 'betting', // betting | spinning | resolved
  bettingEndsAt: Date.now() + BETTING_DURATION_MS,
  winningNumber: null,
  history: [],
  statusMessage: 'Placez vos mises',
  statusKind: '',

  // players : Map(playerId -> { id, name, sockets:Set<ws>, bets:{}, betLog:[], ready, lastResult })
  players: new Map(),

  // Démarrage accéléré / fin de la phase de mise
  bettingResolve: null,
  bettingDeadlineTimer: null,
  bettingFastTimer: null,
};

function getPlayer(playerId) {
  return table.players.get(playerId);
}

function playerTotalBet(player) {
  return Object.values(player.bets).reduce((a, b) => a + b, 0);
}

// Nombre de joueurs réellement connectés (au moins un socket ouvert). Les
// joueurs déconnectés restent en mémoire (pour retrouver leurs mises/solde
// à la reconnexion) mais ne doivent pas gonfler indéfiniment le compteur
// "X à la table" affiché à l'écran.
function countConnectedPlayers() {
  let n = 0;
  for (const p of table.players.values()) if (p.sockets.size > 0) n++;
  return n;
}

function newPlayerRecord(playerId) {
  return {
    id: playerId,
    name: getOrCreatePlayerRecord(playerId).name,
    sockets: new Set(),
    bets: {},
    betLog: [],
    ready: false,
    lastResult: null,
  };
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
  for (const player of table.players.values()) {
    for (const client of player.sockets) {
      if (client.readyState === client.OPEN) client.send(raw);
    }
  }
}

function serializeState() {
  return {
    type: 'state',
    phase: table.phase,
    bettingEndsAt: table.bettingEndsAt,
    winningNumber: table.winningNumber,
    history: table.history,
    statusMessage: table.statusMessage,
    statusKind: table.statusKind,
    playersCount: table.players.size,
    players: Array.from(table.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.sockets.size > 0,
      bankroll: playersDB[p.id] ? playersDB[p.id].bankroll : START_BANKROLL,
      // Record personnel (plus haut solde de jetons jamais atteint), utilisé
      // par le panneau de classement (voir buildLeaderboard / "getLeaderboard").
      record: playersDB[p.id] && Number.isFinite(playersDB[p.id].record) ? playersDB[p.id].record : START_BANKROLL,
      bets: p.bets,
      totalBet: playerTotalBet(p),
      ready: p.ready,
      lastResult: p.lastResult,
    })),
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

// ---------- Démarrage accéléré de la phase de mise ----------
// Un joueur CONNECTÉ et "engagé" (au moins une mise) bloque le démarrage
// accéléré tant qu'il n'a pas cliqué sur "Prêt". Un joueur non engagé
// (aucune mise) ne bloque ni ne déclenche rien.
function allEngagedPlayersReady() {
  let anyEngaged = false;
  for (const player of table.players.values()) {
    if (player.sockets.size === 0) continue; // seuls les joueurs connectés comptent
    if (playerTotalBet(player) <= 0) continue; // pas engagé, ne bloque pas
    anyEngaged = true;
    if (!player.ready) return false;
  }
  return anyEngaged;
}

function finishBetting() {
  if (!table.bettingResolve) return;
  clearTimeout(table.bettingDeadlineTimer);
  clearTimeout(table.bettingFastTimer);
  table.bettingDeadlineTimer = null;
  table.bettingFastTimer = null;
  const resolve = table.bettingResolve;
  table.bettingResolve = null;
  resolve();
}

// À appeler après toute action susceptible de changer si "tout le monde est
// prêt" (mise, annulation, ready, connexion/déconnexion).
function scheduleFastStartCheck() {
  if (table.phase !== 'betting' || !table.bettingResolve) return;
  const ready = allEngagedPlayersReady();
  if (ready) {
    if (!table.bettingFastTimer) {
      table.bettingFastTimer = setTimeout(() => finishBetting(), FAST_START_DELAY_MS);
    }
  } else if (table.bettingFastTimer) {
    clearTimeout(table.bettingFastTimer);
    table.bettingFastTimer = null;
  }
}

// Un joueur qui rejoint la table pendant un compte à rebours accéléré doit
// avoir le temps normal de miser : on annule le démarrage accéléré en cours
// (il repartira de lui-même via scheduleFastStartCheck si tout le monde,
// nouveau venu inclus, finit par se déclarer prêt).
function cancelFastStart() {
  if (table.bettingFastTimer) {
    clearTimeout(table.bettingFastTimer);
    table.bettingFastTimer = null;
  }
}

// ---------- Boucle principale de la table ----------
async function runTableLoop() {
  for (;;) {
    await bettingPhase();

    const engaged = Array.from(table.players.values()).filter((p) => playerTotalBet(p) > 0);
    if (engaged.length === 0) {
      table.statusMessage = 'Personne n\'a misé — nouvelle manche';
      table.statusKind = '';
      broadcastState();
      await delay(EMPTY_ROUND_PAUSE_MS);
      continue;
    }

    await spinPhase(engaged);
    resolveRound(engaged);
    broadcastState();
    await delay(RESULT_PAUSE_MS);
    resetForNextRound();
  }
}

async function bettingPhase() {
  table.phase = 'betting';
  table.winningNumber = null;
  table.bettingEndsAt = Date.now() + BETTING_DURATION_MS;
  table.statusMessage = 'Placez vos mises';
  table.statusKind = '';
  dealerSay('Faites vos jeux, mesdames et messieurs.');
  broadcastState();

  await new Promise((resolve) => {
    table.bettingResolve = resolve;
    table.bettingDeadlineTimer = setTimeout(() => finishBetting(), BETTING_DURATION_MS);
    // Cas table à un seul joueur déjà prêt dès l'ouverture (rare mais
    // possible juste après un reset) : vérifie immédiatement.
    scheduleFastStartCheck();
  });
}

async function spinPhase(engaged) {
  table.phase = 'spinning';

  // Débite la mise totale de chaque joueur engagé.
  for (const player of engaged) {
    const total = playerTotalBet(player);
    const rec = getOrCreatePlayerRecord(player.id);
    setBankroll(rec, Math.max(0, rec.bankroll - total));
  }
  savePlayersDB();

  table.winningNumber = secureRandomInt(POCKET_COUNT);
  table.statusMessage = 'La bille tourne…';
  table.statusKind = '';
  dealerSay('Les jeux sont faits, rien ne va plus.', 3200);
  broadcastState();

  await delay(SPIN_DURATION_MS);
}

function resolveRound(engaged) {
  table.phase = 'resolved';
  const n = table.winningNumber;

  let anyWin = false;
  let anyLose = false;

  for (const player of engaged) {
    let winnings = 0;
    for (const [betId, amount] of Object.entries(player.bets)) {
      if (betWins(betId, n)) winnings += amount * betMultiplier(betId);
    }
    const total = playerTotalBet(player);
    player.lastResult = { number: n, winnings, totalBet: total };

    if (winnings > total) anyWin = true;
    else if (winnings < total) anyLose = true;

    const rec = getOrCreatePlayerRecord(player.id);
    setBankroll(rec, rec.bankroll + winnings);
    if (rec.bankroll <= 0) setBankroll(rec, START_BANKROLL); // filet de sécurité, table amicale
  }
  savePlayersDB();

  table.history.unshift(n);
  if (table.history.length > HISTORY_MAX) table.history.length = HISTORY_MAX;

  const colorLabel = numberColor(n) === 'red' ? 'Rouge' : numberColor(n) === 'black' ? 'Noir' : 'Zéro';
  table.statusMessage = `${n} · ${colorLabel}`;
  table.statusKind = anyWin && !anyLose ? 'win' : anyLose && !anyWin ? 'lose' : 'push';
  dealerSay(announceResult(n), 3200);
}

function resetForNextRound() {
  for (const player of table.players.values()) {
    player.bets = {};
    player.betLog = [];
    player.ready = false;
    player.lastResult = null;
  }
  table.winningNumber = null;
}

// ---------- Connexions WebSocket ----------
function attachPlayerSocket(ws, playerId) {
  let player = getPlayer(playerId);
  if (!player) {
    player = newPlayerRecord(playerId);
    table.players.set(playerId, player);
  }
  player.sockets.add(ws);
  ws.playerId = playerId;

  // Un nouveau venu doit avoir le temps normal de miser.
  cancelFastStart();

  const rec = getOrCreatePlayerRecord(playerId);
  send(ws, {
    type: 'welcome',
    playerId,
    name: rec.name,
    bankroll: rec.bankroll,
    record: rec.record,
  });
  send(ws, serializeState());
}

function detachPlayerSocket(ws) {
  const player = getPlayer(ws.playerId);
  if (!player) return;
  player.sockets.delete(ws);
  broadcastState(); // met à jour le nombre de joueurs / statut connecté
  scheduleFastStartCheck(); // un départ peut rendre la table "prête"
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
      case 'setName': {
        const name = sanitizeName(msg.name);
        if (!name) return;
        const rec = getOrCreatePlayerRecord(playerId);
        rec.name = name;
        player.name = name;
        savePlayersDB();
        broadcastState();
        break;
      }
      case 'bet': {
        if (table.phase !== 'betting') return;
        const betId = msg.betId;
        const amount = Number(msg.amount);
        if (typeof betId !== 'string' || !VALID_BET_IDS.has(betId)) return;
        if (!ALLOWED_CHIP_VALUES.has(amount)) return;
        const rec = getOrCreatePlayerRecord(playerId);
        const currentTotal = playerTotalBet(player);
        if (currentTotal + amount > rec.bankroll) return; // fonds insuffisants
        player.bets[betId] = (player.bets[betId] || 0) + amount;
        player.betLog.push({ betId, amount });
        player.ready = false;
        broadcastState();
        scheduleFastStartCheck();
        break;
      }
      case 'undoBet': {
        if (table.phase !== 'betting') return;
        const last = player.betLog.pop();
        if (!last) return;
        player.bets[last.betId] -= last.amount;
        if (player.bets[last.betId] <= 0) delete player.bets[last.betId];
        player.ready = false;
        broadcastState();
        scheduleFastStartCheck();
        break;
      }
      case 'clearBets': {
        if (table.phase !== 'betting') return;
        if (Object.keys(player.bets).length === 0) return;
        player.bets = {};
        player.betLog = [];
        player.ready = false;
        broadcastState();
        scheduleFastStartCheck();
        break;
      }
      case 'ready': {
        if (table.phase !== 'betting') return;
        if (playerTotalBet(player) <= 0) return;
        player.ready = true;
        broadcastState();
        scheduleFastStartCheck();
        break;
      }
      case 'getLeaderboard': {
        // Classement global (tous joueurs connus du serveur) : envoyé
        // uniquement au demandeur, pas de diffusion à toute la table.
        send(ws, { type: 'leaderboard', entries: buildLeaderboard() });
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
  // On accepte toute requête d'upgrade se terminant par "/ws" : selon la
  // config du reverse proxy (nginx), un déploiement sous un sous-chemin
  // (ex. /roulette/) peut soit conserver ce préfixe jusqu'ici, soit le
  // retirer avant de transmettre au backend. Le client (script.js) construit
  // toujours son URL de façon relative à son propre chemin, donc les deux
  // cas sont couverts.
  const url = (req.url || '').split('?')[0];
  if (url === '/ws' || url.endsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ---------- Démarrage ----------
loadPlayersDB();
runTableLoop().catch((err) => {
  console.error('Erreur fatale dans la boucle de la table :', err);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`Roulette (table partagée) en écoute sur le port ${PORT}`);
  console.log(`HTTP : http://localhost:${PORT}  —  WebSocket : ws://localhost:${PORT}/ws`);
});
