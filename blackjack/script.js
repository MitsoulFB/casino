'use strict';

/* ============================================================
   BLACKJACK — client de la table partagée
   ------------------------------------------------------------
   Ce script ne décide plus de rien : le serveur (server.js) fait
   autorité sur le sabot, les mains, les tours et les soldes. Le
   client se contente d'envoyer les actions du joueur et de rendre
   à l'écran chaque "state" reçu par websocket. Reconnexion auto en
   cas de coupure.
   ============================================================ */

const PLAYER_ID_KEY = 'maison21_playerId';
const BANKROLL_CACHE_KEY = 'maison21_bankroll'; // simple cache d'affichage hors-ligne
const MAX_HANDS = 4;

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

// ---------- Table courante (publique par défaut, ou privée via ?table=CODE) ----------
// Le code de table est lu une fois au chargement de la page depuis l'URL, et
// transmis au serveur dans le message "hello" (pas en query string du
// websocket, pour rester robuste face à un reverse proxy). Rejoindre/créer
// une autre table se fait en changeant l'URL puis en rechargeant la page.
function readTableCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('table');
  if (!raw) return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return cleaned || null;
}
const myTableCode = readTableCodeFromUrl(); // null = table publique

function tableUrlFor(code) {
  const basePath = location.pathname.replace(/[^/]*$/, '');
  return `${location.origin}${basePath}?table=${code}`;
}

function cacheBankroll(n) {
  try { localStorage.setItem(BANKROLL_CACHE_KEY, String(n)); } catch { /* ignore */ }
}
function loadCachedBankroll() {
  const n = parseInt(localStorage.getItem(BANKROLL_CACHE_KEY), 10);
  return Number.isFinite(n) ? n : 1000;
}

// ---------- Pseudo (cache d'affichage hors-ligne, comme le solde) ----------
const NAME_CACHE_KEY = 'maison21_name';
function cacheName(name) {
  try { localStorage.setItem(NAME_CACHE_KEY, name); } catch { /* ignore */ }
}
function loadCachedName() {
  try { return localStorage.getItem(NAME_CACHE_KEY) || 'Joueur'; } catch { return 'Joueur'; }
}

// ---------- DOM refs ----------
const els = {
  bankroll: document.getElementById('bankroll'),
  bankrollPill: document.querySelector('.bankroll-pill'),
  playersCount: document.getElementById('playersCount'),
  playersPill: document.getElementById('playersPill'),
  connDot: document.getElementById('connDot'),
  chipRack: document.getElementById('chipRack'),
  clearBetBtn: document.getElementById('clearBetBtn'),
  addHandBtn: document.getElementById('addHandBtn'),
  betZone: document.getElementById('betZone'),
  ownHandsTabs: document.getElementById('ownHandsTabs'),
  gameActions: document.getElementById('gameActions'),
  hitBtn: document.getElementById('hitBtn'),
  standBtn: document.getElementById('standBtn'),
  doubleBtn: document.getElementById('doubleBtn'),
  splitBtn: document.getElementById('splitBtn'),
  waitingNote: document.getElementById('waitingNote'),
  dealerCards: document.getElementById('dealerCards'),
  dealerScore: document.getElementById('dealerScore'),
  handsRow: document.getElementById('handsRow'),
  statusMessage: document.getElementById('statusMessage'),
  bettingTimer: document.getElementById('bettingTimer'),
  toast: document.getElementById('toast'),
  rulesBtn: document.getElementById('rulesBtn'),
  closeRulesBtn: document.getElementById('closeRulesBtn'),
  rulesModal: document.getElementById('rulesModal'),
  shoeStack: document.getElementById('shoeStack'),
  shoeCount: document.getElementById('shoeCount'),
  shoeDecks: document.getElementById('shoeDecks'),
  dealerCallout: document.getElementById('dealerCallout'),
  tablePill: document.getElementById('tablePill'),
  tableLabel: document.getElementById('tableLabel'),
  closeTableBtn: document.getElementById('closeTableBtn'),
  tableModal: document.getElementById('tableModal'),
  currentTableCode: document.getElementById('currentTableCode'),
  currentTableKind: document.getElementById('currentTableKind'),
  copyTableLinkBtn: document.getElementById('copyTableLinkBtn'),
  createTableBtn: document.getElementById('createTableBtn'),
  joinTableInput: document.getElementById('joinTableInput'),
  joinTableBtn: document.getElementById('joinTableBtn'),
  leaveTableBtn: document.getElementById('leaveTableBtn'),
  // Pseudo personnalisable
  profilePill: document.getElementById('profilePill'),
  myNameLabel: document.getElementById('myNameLabel'),
  nameModal: document.getElementById('nameModal'),
  closeNameBtn: document.getElementById('closeNameBtn'),
  nameInput: document.getElementById('nameInput'),
  saveNameBtn: document.getElementById('saveNameBtn'),
  nameError: document.getElementById('nameError'),
  // Classement (leaderboard)
  leaderboardBtn: document.getElementById('leaderboardBtn'),
  leaderboardModal: document.getElementById('leaderboardModal'),
  closeLeaderboardBtn: document.getElementById('closeLeaderboardBtn'),
  leaderboardList: document.getElementById('leaderboardList'),
  // Exclusion pour inactivité
  exclusionModal: document.getElementById('exclusionModal'),
  exclusionMessage: document.getElementById('exclusionMessage'),
  rejoinTableBtn: document.getElementById('rejoinTableBtn'),
};

// ---------- État local ----------
let latestState = null;
let selectedHandIndex = 0;
let dealerCalloutTimer = null;
let bettingTickInterval = null;
const cardRenderCache = new Map(); // key -> { count, holeRevealed }
const podElements = new Map();     // key -> DOM element du pod de main

// ---------- Rendu des cartes ----------
function renderCardFace(card) {
  const isRed = card.color === 'red';
  return `
    <div class="card-face card-front${isRed ? ' red' : ''}">
      <div class="card-rank-top"><span>${card.rank}</span><span class="card-suit-small">${card.symbol}</span></div>
      <div class="card-suit-center">${card.symbol}</div>
      <div class="card-rank-bottom"><span>${card.rank}</span><span class="card-suit-small">${card.symbol}</span></div>
    </div>`;
}

function makeCardSlot(card) {
  const slot = document.createElement('div');
  slot.className = 'card-slot';
  if (card.hidden) {
    // Carte cachée : uniquement le dos, affiché grâce à la classe
    // "flipped" qui fait pivoter card-inner de 180° (voir style.css).
    slot.classList.add('flipped');
    slot.innerHTML = `<div class="card-inner"><div class="card-face card-back"></div></div>`;
  } else {
    slot.innerHTML = `<div class="card-inner">${renderCardFace(card)}<div class="card-face card-back"></div></div>`;
  }
  return slot;
}

// Rend une liste de cartes dans un conteneur en ne touchant qu'aux
// cartes nouvellement ajoutées (évite de rejouer les animations sur
// des mises à jour qui ne concernent pas cette main).
function renderCardsIncremental(container, cardsData, cacheKey, holeRevealed) {
  let cache = cardRenderCache.get(cacheKey);
  if (!cache) { cache = { count: 0, holeRevealed: false }; cardRenderCache.set(cacheKey, cache); }

  if (cardsData.length < cache.count) {
    container.innerHTML = '';
    cache.count = 0;
    cache.holeRevealed = false;
  }

  for (let i = cache.count; i < cardsData.length; i++) {
    container.appendChild(makeCardSlot(cardsData[i]));
  }

  // Révélation de la carte cachée du croupier : on remplace le contenu
  // du slot existant plutôt que de le recréer, pour un rendu propre.
  if (holeRevealed !== undefined && !cache.holeRevealed && holeRevealed) {
    const slot = container.children[1];
    const card = cardsData[1];
    if (slot && card && !card.hidden) {
      slot.querySelector('.card-inner').innerHTML = `${renderCardFace(card)}<div class="card-face card-back"></div>`;
      // Retire "flipped" pour déclencher l'animation de retournement CSS.
      requestAnimationFrame(() => slot.classList.remove('flipped'));
    }
  }

  cache.count = cardsData.length;
  if (holeRevealed !== undefined) cache.holeRevealed = holeRevealed;
}

function labelForHand(total, isSoft, cardsLength, state, fromSplit) {
  if (cardsLength === 0) return '';
  // Une main issue d'un split n'est jamais un blackjack naturel, même à 21
  // avec 2 cartes (paie 1:1, pas 3:2) : on affiche juste le total.
  if (!fromSplit && (state === 'blackjack' || (cardsLength === 2 && total === 21))) return 'Blackjack !';
  if (total > 21) return `${total} — Sauté`;
  return isSoft && total !== 21 ? `${total} (souple)` : `${total}`;
}

function applyScoreBadgeClasses(el, total, cardsLength, fromSplit) {
  el.className = 'hand-score';
  if (total > 21) el.classList.add('bust');
  if (!fromSplit && cardsLength === 2 && total === 21) el.classList.add('blackjack');
}

// ---------- Rendu du croupier ----------
function renderDealer(dealer) {
  renderCardsIncremental(els.dealerCards, dealer.cards, 'dealer', dealer.holeRevealed);

  if (dealer.cards.length === 0) {
    els.dealerScore.textContent = '';
    els.dealerScore.className = 'hand-score';
    return;
  }
  if (!dealer.holeRevealed) {
    const up = dealer.cards[0];
    els.dealerScore.textContent = up.hidden ? '' : `${up.rank}${up.symbol}`;
    els.dealerScore.className = 'hand-score';
    return;
  }
  const label = labelForHand(dealer.total, dealer.isSoft, dealer.cards.length, dealer.isBlackjack ? 'blackjack' : '');
  els.dealerScore.textContent = label;
  applyScoreBadgeClasses(els.dealerScore, dealer.total, dealer.cards.length);
}

// ---------- Rendu de la rangée de mains (tous les joueurs) ----------
function renderHandsRow(state) {
  const seenKeys = new Set();

  state.players.forEach((player) => {
    const isMe = player.id === myPlayerId;
    player.hands.forEach((hand, handIndex) => {
      const key = `${player.id}:${handIndex}`;

      // Table propre : on n'affiche pas les emplacements vides des
      // joueurs déconnectés (ils restent en mémoire pour retrouver
      // leur solde à la reconnexion, mais n'encombrent pas la table).
      const isEmpty = hand.bet <= 0 && hand.cards.length === 0;
      if (!player.connected && isEmpty && !isMe) return;

      seenKeys.add(key);

      let pod = podElements.get(key);
      if (!pod) {
        pod = document.createElement('div');
        pod.className = 'hand-pod';
        pod.innerHTML = `
          <div class="hand-pod-owner"></div>
          <div class="hand-score"></div>
          <div class="cards"></div>
          <div class="hand-pod-footer">
            <span class="hand-pod-bet"></span>
            <span class="hand-pod-result"></span>
          </div>`;
        podElements.set(key, pod);
      }
      els.handsRow.appendChild(pod); // no-op si déjà au bon endroit, sinon déplace sans recréer

      const isActive = state.activeTurn && state.activeTurn.playerId === player.id && state.activeTurn.handIndex === handIndex;
      pod.classList.toggle('mine', isMe);
      pod.classList.toggle('active-turn', !!isActive);
      pod.classList.toggle('empty', hand.cards.length === 0 && hand.bet === 0);
      pod.classList.toggle('excluded', !!player.excluded);

      // Le pseudo est un texte fourni par un joueur (personnalisable via
      // l'UI, voir setName) : on l'injecte TOUJOURS via textContent, jamais
      // via innerHTML, pour empêcher toute exécution de HTML/JS injecté
      // (XSS). Voir aussi sayDealer() plus bas pour la même règle côté
      // annonces du croupier.
      const ownerEl = pod.querySelector('.hand-pod-owner');
      ownerEl.innerHTML = '';
      if (isMe) {
        const badge = document.createElement('span');
        badge.className = 'me-badge';
        badge.textContent = `Vous${player.hands.length > 1 ? ` · Main ${handIndex + 1}` : ''}`;
        ownerEl.appendChild(badge);
      } else {
        ownerEl.textContent = player.hands.length > 1 ? `${player.name} · Main ${handIndex + 1}` : player.name;
      }
      if (player.excluded) {
        const badge = document.createElement('span');
        badge.className = 'excluded-badge';
        badge.textContent = '🚫';
        badge.title = 'Exclu(e) pour inactivité';
        ownerEl.appendChild(badge);
      }

      const cardsEl = pod.querySelector('.cards');
      renderCardsIncremental(cardsEl, hand.cards, key, undefined);

      const scoreEl = pod.querySelector('.hand-score');
      scoreEl.textContent = labelForHand(hand.total, hand.isSoft, hand.cards.length, hand.state, hand.fromSplit);
      applyScoreBadgeClasses(scoreEl, hand.total, hand.cards.length, hand.fromSplit);

      const betEl = pod.querySelector('.hand-pod-bet');
      betEl.textContent = hand.bet > 0 ? `Mise : ${hand.bet.toLocaleString('fr-FR')}` : '';
      betEl.hidden = hand.bet <= 0;

      const resultEl = pod.querySelector('.hand-pod-result');
      if (hand.result) {
        const txt = hand.result === 'win' ? `+${hand.payout}` : hand.result === 'push' ? 'Push' : 'Perdu';
        resultEl.textContent = txt;
        resultEl.className = `hand-pod-result ${hand.result}`;
      } else {
        resultEl.textContent = '';
        resultEl.className = 'hand-pod-result';
      }
    });
  });

  // Nettoie les pods de mains qui n'existent plus (main retirée, joueur parti au reset).
  for (const [key, pod] of podElements) {
    if (!seenKeys.has(key)) {
      pod.remove();
      podElements.delete(key);
      cardRenderCache.delete(key);
    }
  }
}

// ---------- Mise / mes mains ----------
function myPlayer(state) {
  return state.players.find((p) => p.id === myPlayerId) || null;
}

function renderOwnHandsTabs(state) {
  const me = myPlayer(state);
  if (!me) { els.ownHandsTabs.innerHTML = ''; return; }

  if (selectedHandIndex >= me.hands.length) selectedHandIndex = Math.max(0, me.hands.length - 1);

  els.ownHandsTabs.innerHTML = '';
  me.hands.forEach((hand, i) => {
    const tab = document.createElement('div');
    tab.className = 'hand-tab' + (i === selectedHandIndex ? ' selected' : '');
    tab.innerHTML = `<span>Main ${i + 1}</span><span class="amount">${hand.bet.toLocaleString('fr-FR')}</span>`;
    tab.addEventListener('click', () => { selectedHandIndex = i; renderOwnHandsTabs(latestState); });
    if (me.hands.length > 1) {
      const rm = document.createElement('span');
      rm.className = 'remove-hand';
      rm.textContent = '×';
      rm.title = 'Retirer cette main';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: 'removeHand', handIndex: i });
      });
      tab.appendChild(rm);
    }
    els.ownHandsTabs.appendChild(tab);
  });

  els.addHandBtn.disabled = me.hands.length >= MAX_HANDS;
}

function updateChipAvailability(state) {
  const me = myPlayer(state);
  const bankroll = me ? me.bankroll : loadCachedBankroll();
  const totalBet = me ? me.hands.reduce((s, h) => s + h.bet, 0) : 0;
  const chips = els.chipRack.querySelectorAll('.chip');
  chips.forEach((chip) => {
    const val = parseInt(chip.dataset.value, 10);
    chip.disabled = val > bankroll - totalBet;
  });
}

// ---------- Sabot ----------
function updateShoeVisual(shoeState) {
  const fraction = Math.max(shoeState.remaining / shoeState.total, 0);
  els.shoeStack.style.height = `${Math.max(fraction * 100, 2)}%`;
  els.shoeCount.textContent = shoeState.remaining;
  els.shoeCount.classList.toggle('low', shoeState.remaining <= shoeState.cutCardIndex + 20);
  els.shoeDecks.textContent = `${(shoeState.remaining / 52).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} jeux`;
}

// ---------- Statut / minuteur de mise ----------
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
  els.bettingTimer.textContent = `Distribution dans ${seconds}s`;
  els.bettingTimer.classList.toggle('urgent', seconds <= 5);
}

// ---------- Toast / annonces du croupier ----------
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function sayDealer(text, duration = 2600) {
  // Le texte peut être composé côté serveur avec un pseudo de joueur (ex.
  // "X reprend place à la table.") : toujours injecté en textContent,
  // jamais en innerHTML, pour empêcher une injection HTML/JS (XSS) via un
  // pseudo personnalisé. Le <span> est recréé "à la main" pour conserver
  // exactement le même rendu (voir .dealer-callout span en CSS).
  clearTimeout(dealerCalloutTimer);
  els.dealerCallout.textContent = '';
  const span = document.createElement('span');
  span.textContent = text;
  els.dealerCallout.appendChild(span);
  dealerCalloutTimer = setTimeout(() => { els.dealerCallout.textContent = ''; }, duration);
}

// ---------- Exclusion pour inactivité ----------
// Ouvre/ferme la modale d'exclusion en fonction de `me.excluded` (issu du
// dernier "state" reçu). Volontairement, la modale ne se ferme QUE quand le
// serveur confirme la réintégration (pas de fermeture au clic sur le fond
// ni de bouton ×) : c'est le clic explicite sur "Reprendre place à la
// table" qui doit débloquer le joueur, comme demandé au cahier des charges.
function syncExclusionModal(me) {
  if (me && me.excluded) {
    // Ne réécrit pas le message si "excludedNotice" (plus précis, envoyé au
    // moment de l'exclusion) l'a déjà fait — voir le handler websocket.
    if (!els.exclusionModal.classList.contains('open')) {
      els.exclusionMessage.textContent = 'Vous avez manqué votre tour sur deux manches consécutives : vous ne pouvez plus miser ni jouer sur cette table.';
    }
    els.exclusionModal.classList.add('open');
  } else {
    els.exclusionModal.classList.remove('open');
  }
}

// Vrai si le joueur courant est actuellement exclu (d'après le dernier
// state connu) : sert de garde-fou côté client sur les actions de mise/jeu,
// en complément du blocage déjà assuré par la modale plein écran ci-dessus
// et, de toute façon, systématiquement revérifié côté serveur.
function amIExcluded() {
  const me = latestState ? myPlayer(latestState) : null;
  return !!(me && me.excluded);
}

// ---------- Rendu global à partir d'un "state" serveur ----------
function render(state) {
  latestState = state;

  // Connexion / joueurs à table
  els.playersCount.textContent = state.playersCount;

  // Bankroll (le mien)
  const me = myPlayer(state);
  const bankroll = me ? me.bankroll : loadCachedBankroll();
  els.bankroll.textContent = bankroll.toLocaleString('fr-FR');
  cacheBankroll(bankroll);

  // Pseudo (le mien) : toujours resynchronisé depuis le state serveur
  // (source de vérité), qui reflète immédiatement tout changement via
  // setName — y compris depuis un autre onglet/appareil du même joueur.
  if (me && me.name) {
    els.myNameLabel.textContent = me.name;
    cacheName(me.name);
  }

  // Exclusion pour inactivité (2 manches manquées consécutives) : la modale
  // s'ouvre/se ferme automatiquement en suivant `me.excluded`, y compris
  // après une reconnexion (pas seulement au moment du message dédié
  // "excludedNotice", voir le handler websocket plus bas).
  syncExclusionModal(me);

  updateShoeVisual(state.shoe);
  renderDealer(state.dealer);
  renderHandsRow(state);
  updateChipAvailability(state);

  setStatus(state.statusMessage, state.statusKind);
  tickBettingTimer();

  // Zone de mise visible seulement pendant la phase de mise.
  const betting = state.phase === 'betting';
  els.betZone.hidden = !betting;
  els.betZone.style.display = betting ? 'flex' : 'none';
  if (betting) renderOwnHandsTabs(state);

  // Actions de jeu : visibles pendant playing/dealer/resolved, actives
  // seulement si c'est mon tour.
  const showActions = state.phase === 'playing' || state.phase === 'dealer' || state.phase === 'resolved';
  els.gameActions.hidden = !showActions;

  const myTurn = state.phase === 'playing' && state.activeTurn && state.activeTurn.playerId === myPlayerId;
  els.hitBtn.hidden = !myTurn;
  els.standBtn.hidden = !myTurn;
  const activeHandMine = myTurn ? me.hands[state.activeTurn.handIndex] : null;
  els.doubleBtn.hidden = !myTurn || !activeHandMine || activeHandMine.cards.length !== 2;
  els.hitBtn.disabled = !myTurn;
  els.standBtn.disabled = !myTurn;
  els.doubleBtn.disabled = !myTurn || !activeHandMine || (bankroll < (activeHandMine ? activeHandMine.bet : Infinity));

  const canSplit = !!(myTurn && activeHandMine && me
    && activeHandMine.cards.length === 2
    && activeHandMine.cards[0].rank === activeHandMine.cards[1].rank
    && me.hands.length < MAX_HANDS
    && bankroll >= activeHandMine.bet);
  els.splitBtn.hidden = !myTurn;
  els.splitBtn.disabled = !canSplit;

  els.waitingNote.hidden = myTurn || !showActions;
}

// ---------- Connexion WebSocket ----------
let ws = null;
let reconnectDelay = 1000;
const RECONNECT_MAX = 10000;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Chemin de base = dossier de la page actuelle (enlève le nom de fichier
  // éventuel, ex. "index.html"). Permet au jeu de fonctionner aussi bien
  // servi à la racine du domaine que sous un sous-chemin comme /blackjack/
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
    send({ type: 'hello', playerId: myPlayerId, tableCode: myTableCode });
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === 'welcome') {
      cacheBankroll(msg.bankroll);
      els.myNameLabel.textContent = msg.name;
      cacheName(msg.name);
      renderTableInfo(msg.tableCode, msg.isPublicTable);
    } else if (msg.type === 'state') {
      render(msg);
    } else if (msg.type === 'dealerSay') {
      sayDealer(msg.text, msg.duration);
    } else if (msg.type === 'toast') {
      showToast(msg.text);
    } else if (msg.type === 'tableCreated') {
      // Le serveur a généré un code de table privée inédit : on y va.
      location.href = tableUrlFor(msg.tableCode);
    } else if (msg.type === 'excludedNotice') {
      // Message dédié envoyé au moment précis de l'exclusion (texte plus
      // circonstancié que le message générique de secours utilisé par
      // syncExclusionModal lors d'une reconnexion). Texte brut -> textContent.
      els.exclusionMessage.textContent = msg.message;
      els.exclusionModal.classList.add('open');
    } else if (msg.type === 'nameUpdateResult') {
      els.saveNameBtn.disabled = false;
      if (msg.ok) {
        els.myNameLabel.textContent = msg.name;
        cacheName(msg.name);
        els.nameError.hidden = true;
        els.nameModal.classList.remove('open');
        showToast('Pseudo mis à jour !');
      } else {
        els.nameError.textContent = 'Le pseudo ne peut pas être vide.';
        els.nameError.hidden = false;
      }
    } else if (msg.type === 'leaderboard') {
      renderLeaderboard(msg.entries);
    }
  });

  const onDown = () => {
    latestState = null; // évite d'afficher un minuteur/état périmé pendant la coupure
    els.connDot.classList.remove('online');
    setStatus('Connexion perdue — reconnexion…');
    els.gameActions.hidden = true;
    els.betZone.hidden = true;
    els.bettingTimer.hidden = true;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, RECONNECT_MAX);
  };
  ws.addEventListener('close', onDown);
  ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
}

// ---------- Actions du joueur ----------
// Chaque action de mise/jeu vérifie `amIExcluded()` en plus du blocage déjà
// assuré par la modale d'exclusion plein écran (défense en profondeur côté
// client) ; le serveur revérifie de toute façon systématiquement.
els.chipRack.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || chip.disabled || amIExcluded()) return;
  send({ type: 'bet', handIndex: selectedHandIndex, amount: parseInt(chip.dataset.value, 10) });
});
els.clearBetBtn.addEventListener('click', () => { if (!amIExcluded()) send({ type: 'clearBet', handIndex: selectedHandIndex }); });
els.addHandBtn.addEventListener('click', () => { if (!amIExcluded()) send({ type: 'addHand' }); });
els.hitBtn.addEventListener('click', () => { if (!amIExcluded()) send({ type: 'hit' }); });
els.standBtn.addEventListener('click', () => { if (!amIExcluded()) send({ type: 'stand' }); });
els.doubleBtn.addEventListener('click', () => { if (!amIExcluded()) send({ type: 'double' }); });
els.splitBtn.addEventListener('click', () => { if (!els.splitBtn.disabled && !amIExcluded()) send({ type: 'split' }); });

els.rulesBtn.addEventListener('click', () => els.rulesModal.classList.add('open'));
els.closeRulesBtn.addEventListener('click', () => els.rulesModal.classList.remove('open'));
els.rulesModal.addEventListener('click', (e) => {
  if (e.target === els.rulesModal) els.rulesModal.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    els.rulesModal.classList.remove('open');
    els.tableModal.classList.remove('open');
    els.nameModal.classList.remove('open');
    els.leaderboardModal.classList.remove('open');
    // Pas de fermeture au clavier pour la modale d'exclusion : volontaire.
  }
  if (!latestState || amIExcluded()) return;
  const myTurn = latestState.phase === 'playing' && latestState.activeTurn && latestState.activeTurn.playerId === myPlayerId;
  if (myTurn) {
    if (e.key.toLowerCase() === 'h') send({ type: 'hit' });
    if (e.key.toLowerCase() === 's') send({ type: 'stand' });
    if (e.key.toLowerCase() === 'd' && !els.doubleBtn.disabled) send({ type: 'double' });
    if (e.key.toLowerCase() === 'p' && !els.splitBtn.disabled) send({ type: 'split' });
  }
});

// ---------- Table privée : affichage + création/partage/rejoindre ----------
let currentTableCode = 'PUBLIC';
let currentTableIsPublic = true;

function renderTableInfo(tableCode, isPublicTable) {
  currentTableCode = tableCode || 'PUBLIC';
  currentTableIsPublic = !!isPublicTable;

  els.tableLabel.textContent = currentTableIsPublic ? 'Table publique' : currentTableCode;
  els.tablePill.classList.toggle('private', !currentTableIsPublic);
  els.tablePill.title = currentTableIsPublic
    ? 'Table publique — cliquez pour créer ou rejoindre une table privée'
    : `Table privée ${currentTableCode} — cliquez pour partager le lien`;

  els.currentTableCode.textContent = currentTableIsPublic ? '—' : currentTableCode;
  els.currentTableKind.textContent = currentTableIsPublic
    ? 'Vous êtes sur la table publique, ouverte à tout le monde.'
    : 'Table privée : seules les personnes ayant le code ou le lien peuvent la rejoindre.';
  els.copyTableLinkBtn.hidden = currentTableIsPublic;
  els.leaveTableBtn.hidden = currentTableIsPublic;
}

(function initTableModal() {
  if (!els.tablePill || !els.tableModal) return;

  els.tablePill.addEventListener('click', () => els.tableModal.classList.add('open'));
  els.closeTableBtn.addEventListener('click', () => els.tableModal.classList.remove('open'));
  els.tableModal.addEventListener('click', (e) => {
    if (e.target === els.tableModal) els.tableModal.classList.remove('open');
  });

  els.createTableBtn.addEventListener('click', () => {
    els.createTableBtn.disabled = true;
    send({ type: 'createTable' });
    // Filet de sécurité si la réponse tarde/n'arrive pas (socket coupé) :
    // on redonne la main plutôt que de laisser le bouton bloqué.
    setTimeout(() => { els.createTableBtn.disabled = false; }, 4000);
  });

  els.copyTableLinkBtn.addEventListener('click', async () => {
    const url = tableUrlFor(currentTableCode);
    try {
      await navigator.clipboard.writeText(url);
      showToast('Lien de la table copié !');
    } catch {
      showToast(url); // affichage de secours si le presse-papiers est indisponible
    }
  });

  function joinFromInput() {
    const raw = els.joinTableInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!raw) return;
    location.href = tableUrlFor(raw);
  }
  els.joinTableBtn.addEventListener('click', joinFromInput);
  els.joinTableInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinFromInput();
  });

  els.leaveTableBtn.addEventListener('click', () => {
    const basePath = location.pathname.replace(/[^/]*$/, '');
    location.href = `${location.origin}${basePath}`;
  });
})();

// ---------- Pseudo personnalisable ----------
(function initNameModal() {
  if (!els.profilePill || !els.nameModal) return;

  els.profilePill.addEventListener('click', () => {
    const me = latestState ? myPlayer(latestState) : null;
    els.nameInput.value = (me && me.name) || loadCachedName();
    els.nameError.hidden = true;
    els.nameModal.classList.add('open');
    els.nameInput.focus();
  });
  els.closeNameBtn.addEventListener('click', () => els.nameModal.classList.remove('open'));
  els.nameModal.addEventListener('click', (e) => {
    if (e.target === els.nameModal) els.nameModal.classList.remove('open');
  });

  function submitNameChange() {
    const value = els.nameInput.value.trim();
    if (!value) {
      els.nameError.textContent = 'Le pseudo ne peut pas être vide.';
      els.nameError.hidden = false;
      return;
    }
    els.nameError.hidden = true;
    els.saveNameBtn.disabled = true;
    // Validation finale (longueur, vide après trim) faite côté serveur —
    // ceci n'est qu'un pré-contrôle pour un retour instantané.
    send({ type: 'setName', name: value.slice(0, 20) });
    // Filet de sécurité si la réponse tarde/n'arrive pas (socket coupé).
    setTimeout(() => { els.saveNameBtn.disabled = false; }, 4000);
  }
  els.saveNameBtn.addEventListener('click', submitNameChange);
  els.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNameChange();
  });
})();

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
    // HTML/JS (XSS) — voir aussi renderHandsRow() et sayDealer().
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

// ---------- Exclusion pour inactivité : bouton de reprise ----------
(function initExclusionModal() {
  if (!els.rejoinTableBtn) return;
  els.rejoinTableBtn.addEventListener('click', () => {
    els.rejoinTableBtn.disabled = true;
    send({ type: 'rejoinTable' });
    // Filet de sécurité si la réponse tarde/n'arrive pas (socket coupé) :
    // la modale se refermera de toute façon dès que le state confirmera la
    // réintégration (voir syncExclusionModal), mais on redonne la main sur
    // le bouton si rien ne vient.
    setTimeout(() => { els.rejoinTableBtn.disabled = false; }, 4000);
  });
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

// ---------- Init ----------
els.bankroll.textContent = loadCachedBankroll().toLocaleString('fr-FR');
els.gameActions.hidden = true;
els.betZone.hidden = true;
bettingTickInterval = setInterval(tickBettingTimer, 500);
connect();
