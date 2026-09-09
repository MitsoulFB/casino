'use strict';

/* ============================================================
   BLACKJACK — logique de jeu
   Règles : le croupier tire tant qu'il a 16 ou moins, s'arrête à 17+.
   Blackjack (As + 10) à la distribution paie 3:2.
   Sabot de 6 jeux de 52 cartes (312 cartes, sans joker), avec
   carte de coupe réaliste et mélange cryptographiquement aléatoire.
   ============================================================ */

const SUITS = [
  { key: 'spades',   symbol: '♠', color: 'black' },
  { key: 'hearts',   symbol: '♥', color: 'red' },
  { key: 'diamonds', symbol: '♦', color: 'red' },
  { key: 'clubs',    symbol: '♣', color: 'black' },
];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const STORAGE_KEY = 'maison21_bankroll';
const START_BANKROLL = 1000;

const NUM_DECKS = 6;
const CARDS_PER_DECK = 52;
const SHOE_SIZE = NUM_DECKS * CARDS_PER_DECK; // 312 cartes, sans joker

// Pénétration de la carte de coupe : dès que la moitié du sabot a été
// jouée (50%), un nouveau sabot de 6 jeux est annoncé et remélangé.
const CUT_PENETRATION_MIN = 0.5;
const CUT_PENETRATION_MAX = 0.5;

// ---------- State ----------
let shoe = [];          // pile de cartes restantes (le dessus = fin du tableau)
let cutCardIndex = 0;   // nombre de cartes restantes à partir duquel la carte de coupe est atteinte
let needsReshuffle = false;
let bankroll = loadBankroll();
let currentBet = 0;
let playerHand = [];
let dealerHand = [];
let state = 'betting'; // betting | player-turn | dealer-turn | round-over
let dealerHoleRevealed = false;
let dealerCalloutTimer = null;

// ---------- DOM refs ----------
const els = {
  bankroll: document.getElementById('bankroll'),
  bankrollPill: document.querySelector('.bankroll-pill'),
  betAmount: document.getElementById('betAmount'),
  chipRack: document.getElementById('chipRack'),
  clearBetBtn: document.getElementById('clearBetBtn'),
  dealBtn: document.getElementById('dealBtn'),
  betZone: document.getElementById('betZone'),
  gameActions: document.getElementById('gameActions'),
  hitBtn: document.getElementById('hitBtn'),
  standBtn: document.getElementById('standBtn'),
  doubleBtn: document.getElementById('doubleBtn'),
  nextRoundBtn: document.getElementById('nextRoundBtn'),
  dealerCards: document.getElementById('dealerCards'),
  playerCards: document.getElementById('playerCards'),
  dealerScore: document.getElementById('dealerScore'),
  playerScore: document.getElementById('playerScore'),
  statusMessage: document.getElementById('statusMessage'),
  toast: document.getElementById('toast'),
  rulesBtn: document.getElementById('rulesBtn'),
  closeRulesBtn: document.getElementById('closeRulesBtn'),
  rulesModal: document.getElementById('rulesModal'),
  shoeStack: document.getElementById('shoeStack'),
  shoeCount: document.getElementById('shoeCount'),
  shoeDecks: document.getElementById('shoeDecks'),
  dealerCallout: document.getElementById('dealerCallout'),
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
// Génère un flottant [0,1) uniforme via crypto.getRandomValues quand
// disponible (bien plus fiable statistiquement que Math.random pour
// un mélange équitable), avec repli sur Math.random sinon.
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

// ---------- Shoe management ----------
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

// Mélange Fisher-Yates avec source cryptographique — répété sur
// plusieurs passes pour un brassage aussi imprévisible que possible,
// à l'image d'un croupier qui mélange plusieurs fois avant de couper.
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

// Construit un nouveau sabot de 6 jeux (312 cartes, sans joker),
// le mélange, puis place une carte de coupe à une profondeur
// aléatoire réaliste (75-82% du sabot joué avant nouveau mélange).
function buildShoe() {
  const deck = shuffle(buildFreshDecks(NUM_DECKS));
  const penetration = CUT_PENETRATION_MIN + secureRandom() * (CUT_PENETRATION_MAX - CUT_PENETRATION_MIN);
  cutCardIndex = Math.floor(deck.length * (1 - penetration));
  needsReshuffle = false;
  return deck;
}

function drawCard() {
  if (shoe.length === 0) shoe = buildShoe(); // filet de sécurité, ne devrait jamais arriver
  const card = shoe.pop();
  if (shoe.length <= cutCardIndex) needsReshuffle = true;
  updateShoeVisual();
  return card;
}

// ---------- Shoe visual (RP + comptage de cartes) ----------
function updateShoeVisual() {
  const remaining = shoe.length;
  const fraction = Math.max(remaining / SHOE_SIZE, 0);
  els.shoeStack.style.height = `${Math.max(fraction * 100, 2)}%`;
  els.shoeCount.textContent = remaining;
  els.shoeCount.classList.toggle('low', remaining <= cutCardIndex + 20);
  els.shoeDecks.textContent = `${(remaining / CARDS_PER_DECK).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} jeux`;
}

function reshuffleShoeIfNeeded() {
  if (!needsReshuffle) return false;
  shoe = buildShoe();
  updateShoeVisual();
  sayDealer('Nouveau sabot, mesdames et messieurs — on remélange !', 2400);
  showToast('🂠 Nouveau sabot de 6 jeux mélangé');
  return true;
}

// ---------- Hand value ----------
function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (card.rank === 'A') { total += 11; aces++; }
    else if (['J', 'Q', 'K'].includes(card.rank)) total += 10;
    else total += parseInt(card.rank, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  const isSoft = aces > 0;
  return { total, isSoft };
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand).total === 21;
}

// ---------- Rendering ----------
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
  slot.innerHTML = `
    <div class="card-inner">
      ${renderCardFace(card)}
      <div class="card-face card-back"></div>
    </div>`;
  if (faceDown) {
    // start flipped (showing back)
    slot.classList.add('flipped');
  }
  return slot;
}

function flipSlot(slot) {
  slot.classList.remove('flipped');
}

function renderScoreBadge(el, hand, { hideTotal = false, forceLabel = null } = {}) {
  if (hideTotal) { el.textContent = ''; el.className = 'hand-score'; return; }
  const { total, isSoft } = handValue(hand);
  let label = forceLabel;
  if (!label) {
    if (hand.length === 2 && total === 21) label = 'Blackjack !';
    else if (total > 21) label = `${total} — Sauté`;
    else label = isSoft && total !== 21 ? `${total} (souple)` : `${total}`;
  }
  el.textContent = label;
  el.className = 'hand-score';
  if (total > 21) el.classList.add('bust');
  if (hand.length === 2 && total === 21) el.classList.add('blackjack');
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
  els.betAmount.textContent = currentBet.toLocaleString('fr-FR');
  els.dealBtn.disabled = currentBet <= 0;
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

// ---------- Dealer roleplay callouts ----------
// Petites annonces du croupier pour l'ambiance de table, dans le style
// d'un vrai casino francophone.
function sayDealer(text, duration = 2600) {
  clearTimeout(dealerCalloutTimer);
  els.dealerCallout.innerHTML = `<span>${text}</span>`;
  dealerCalloutTimer = setTimeout(() => {
    els.dealerCallout.innerHTML = '';
  }, duration);
}

// ---------- Betting phase ----------
function updateChipAvailability() {
  const chips = els.chipRack.querySelectorAll('.chip');
  chips.forEach((chip) => {
    const val = parseInt(chip.dataset.value, 10);
    chip.disabled = val > bankroll - currentBet;
  });
}

function addToBet(value) {
  if (state !== 'betting') return;
  if (value > bankroll - currentBet) {
    showToast("Fonds insuffisants pour ce jeton");
    return;
  }
  currentBet += value;
  updateBetDisplay();
  updateChipAvailability();
}

function clearBet() {
  if (state !== 'betting') return;
  currentBet = 0;
  updateBetDisplay();
  updateChipAvailability();
}

// ---------- Round flow ----------
function startRound() {
  if (currentBet <= 0 || currentBet > bankroll) return;

  // La carte de coupe n'est jamais franchie en pleine main : on ne
  // remélange qu'ici, entre deux manches.
  const justReshuffled = reshuffleShoeIfNeeded();

  bankroll -= currentBet;
  updateBankrollDisplay();
  saveBankroll();

  state = 'player-turn';
  dealerHoleRevealed = false;
  playerHand = [];
  dealerHand = [];
  els.playerCards.innerHTML = '';
  els.dealerCards.innerHTML = '';
  els.playerScore.textContent = '';
  els.dealerScore.textContent = '';

  els.betZone.hidden = false;
  els.betZone.style.display = 'none';
  els.gameActions.hidden = false;
  els.nextRoundBtn.hidden = true;
  els.hitBtn.disabled = false;
  els.standBtn.disabled = false;
  els.doubleBtn.disabled = currentBet > bankroll;

  setStatus('Distribution en cours…');
  if (!justReshuffled) sayDealer('Les jeux sont faits, rien ne va plus.');
  else setTimeout(() => sayDealer('Les jeux sont faits, rien ne va plus.'), 2500);

  // Deal sequence: player, dealer, player, dealer(hidden)
  const seq = [
    () => dealCardTo('player'),
    () => dealCardTo('dealer'),
    () => dealCardTo('player'),
    () => dealCardTo('dealer', true),
  ];
  let i = 0;
  const step = () => {
    if (i < seq.length) {
      seq[i]();
      i++;
      setTimeout(step, 260);
    } else {
      afterInitialDeal();
    }
  };
  step();
}

function dealCardTo(who, faceDown = false) {
  const card = drawCard();
  if (who === 'player') {
    playerHand.push(card);
    const slot = createCardSlot(card, false);
    els.playerCards.appendChild(slot);
    renderScoreBadge(els.playerScore, playerHand);
  } else {
    dealerHand.push(card);
    const slot = createCardSlot(card, faceDown);
    els.dealerCards.appendChild(slot);
    if (!faceDown) {
      renderScoreBadge(els.dealerScore, dealerHand, { forceLabel: cardLabel(card) });
    } else {
      els.dealerScore.textContent = '';
    }
  }
}

function cardLabel(card) {
  return `${card.rank}${card.symbol}`;
}

function afterInitialDeal() {
  const playerBJ = isBlackjack(playerHand);
  const dealerBJ = isBlackjack(dealerHand);

  if (playerBJ || dealerBJ) {
    revealDealerHole();
    resolveRound();
    return;
  }

  setStatus('Tirez ou restez');
  sayDealer('À vous de jouer.');
}

function revealDealerHole() {
  if (dealerHoleRevealed) return;
  dealerHoleRevealed = true;
  const slots = els.dealerCards.querySelectorAll('.card-slot');
  const holeSlot = slots[1];
  if (holeSlot) flipSlot(holeSlot);
  renderScoreBadge(els.dealerScore, dealerHand);
}

// ---------- Player actions ----------
function playerHit() {
  if (state !== 'player-turn') return;
  dealCardTo('player');
  const { total } = handValue(playerHand);
  els.doubleBtn.disabled = true;
  if (total > 21) {
    setStatus('Sauté ! Vous dépassez 21', 'lose');
    endPlayerTurn(true);
  } else if (total === 21) {
    playerStand();
  }
}

function playerStand() {
  if (state !== 'player-turn') return;
  endPlayerTurn();
}

function playerDouble() {
  if (state !== 'player-turn') return;
  if (playerHand.length !== 2 || currentBet > bankroll) return;
  bankroll -= currentBet;
  currentBet *= 2;
  updateBankrollDisplay();
  updateBetDisplay();
  saveBankroll();
  els.hitBtn.disabled = true;
  els.doubleBtn.disabled = true;
  els.standBtn.disabled = true;
  dealCardTo('player');
  const { total } = handValue(playerHand);
  setTimeout(() => {
    if (total > 21) {
      setStatus('Sauté ! Vous dépassez 21', 'lose');
      endPlayerTurn(true);
    } else {
      endPlayerTurn();
    }
  }, 400);
}

function endPlayerTurn(busted = false) {
  state = 'dealer-turn';
  els.hitBtn.disabled = true;
  els.standBtn.disabled = true;
  els.doubleBtn.disabled = true;

  if (busted) {
    setTimeout(() => { revealDealerHole(); resolveRound(); }, 500);
    return;
  }

  setTimeout(dealerPlay, 500);
}

// ---------- Dealer AI ----------
function dealerPlay() {
  revealDealerHole();
  setStatus('Le croupier joue…');
  sayDealer('Le croupier retourne son jeu.');

  const step = () => {
    const { total } = handValue(dealerHand);
    // Dealer draws while total <= 16, stands on 17+ (including soft 17)
    if (total <= 16) {
      dealCardTo('dealer');
      renderScoreBadge(els.dealerScore, dealerHand);
      setTimeout(step, 650);
    } else {
      setTimeout(resolveRound, 500);
    }
  };
  setTimeout(step, 500);
}

// ---------- Resolution ----------
function resolveRound() {
  state = 'round-over';
  revealDealerHole();

  const player = handValue(playerHand);
  const dealer = handValue(dealerHand);
  const playerBJ = isBlackjack(playerHand);
  const dealerBJ = isBlackjack(dealerHand);

  let outcome; // 'win' | 'lose' | 'push'
  let payout = 0;
  let message = '';

  let dealerLine = '';

  if (playerBJ && dealerBJ) {
    outcome = 'push';
    payout = currentBet;
    message = 'Push — Deux Blackjacks';
    dealerLine = 'Double Blackjack — mise remboursée.';
  } else if (playerBJ) {
    outcome = 'win';
    payout = currentBet + Math.floor(currentBet * 1.5);
    message = 'Blackjack ! Vous gagnez 3:2';
    dealerLine = 'Blackjack, bien joué !';
  } else if (dealerBJ) {
    outcome = 'lose';
    payout = 0;
    message = 'Blackjack du croupier — Vous perdez';
    dealerLine = 'Blackjack pour la maison.';
  } else if (player.total > 21) {
    outcome = 'lose';
    payout = 0;
    message = 'Sauté — Vous perdez';
    dealerLine = 'Dommage, vous avez sauté.';
  } else if (dealer.total > 21) {
    outcome = 'win';
    payout = currentBet * 2;
    message = 'Le croupier saute — Vous gagnez !';
    dealerLine = 'Le croupier saute, la table gagne !';
  } else if (player.total > dealer.total) {
    outcome = 'win';
    payout = currentBet * 2;
    message = `Vous gagnez ! ${player.total} contre ${dealer.total}`;
    dealerLine = 'Bien joué, vous l\'emportez.';
  } else if (player.total < dealer.total) {
    outcome = 'lose';
    payout = 0;
    message = `Vous perdez — ${dealer.total} contre ${player.total}`;
    dealerLine = 'La maison l\'emporte cette fois.';
  } else {
    outcome = 'push';
    payout = currentBet;
    message = `Égalité à ${player.total} — Push`;
    dealerLine = 'Égalité — mise remboursée.';
  }

  bankroll += payout;
  updateBankrollDisplay();
  saveBankroll();

  renderScoreBadge(els.playerScore, playerHand);
  renderScoreBadge(els.dealerScore, dealerHand);

  const kindClass = outcome === 'win' ? 'win' : outcome === 'lose' ? 'lose' : 'push';
  setStatus(message, kindClass);
  sayDealer(dealerLine);

  els.gameActions.querySelectorAll('#hitBtn,#standBtn,#doubleBtn').forEach(b => b.hidden = true);
  els.nextRoundBtn.hidden = false;

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
  currentBet = 0;
  updateBetDisplay();
  updateChipAvailability();

  els.gameActions.hidden = true;
  els.gameActions.querySelectorAll('#hitBtn,#standBtn,#doubleBtn').forEach(b => b.hidden = false);
  els.nextRoundBtn.hidden = true;
  els.betZone.style.display = 'flex';

  els.playerCards.innerHTML = '';
  els.dealerCards.innerHTML = '';
  els.playerScore.textContent = '';
  els.dealerScore.textContent = '';
  setStatus('Placez votre mise pour commencer');
  sayDealer('Faites vos jeux, mesdames et messieurs.');
}

// ---------- Event bindings ----------
els.chipRack.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  addToBet(parseInt(chip.dataset.value, 10));
});
els.clearBetBtn.addEventListener('click', clearBet);
els.dealBtn.addEventListener('click', startRound);
els.hitBtn.addEventListener('click', playerHit);
els.standBtn.addEventListener('click', playerStand);
els.doubleBtn.addEventListener('click', playerDouble);
els.nextRoundBtn.addEventListener('click', nextRound);

els.rulesBtn.addEventListener('click', () => els.rulesModal.classList.add('open'));
els.closeRulesBtn.addEventListener('click', () => els.rulesModal.classList.remove('open'));
els.rulesModal.addEventListener('click', (e) => {
  if (e.target === els.rulesModal) els.rulesModal.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') els.rulesModal.classList.remove('open');
  if (state === 'player-turn') {
    if (e.key.toLowerCase() === 'h') playerHit();
    if (e.key.toLowerCase() === 's') playerStand();
    if (e.key.toLowerCase() === 'd' && !els.doubleBtn.disabled) playerDouble();
  }
});

// ---------- Init ----------
function init() {
  shoe = buildShoe();
  updateShoeVisual();
  updateBankrollDisplay(false);
  updateBetDisplay();
  updateChipAvailability();
  els.gameActions.hidden = true;
  sayDealer('Bienvenue à la table ! Faites vos jeux.');
}
init();
