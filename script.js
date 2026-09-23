'use strict';

/* ============================================================
   MAISON21 — page d'accueil / lobby
   ------------------------------------------------------------
   Page purement statique : les 3 cartes de jeu sont de simples
   liens <a>, aucune logique de jeu ici. Seul le petit menu
   inter-jeux (identique sur les 4 pages du site) a besoin de JS.
   ============================================================ */

// ---------- Menu inter-jeux ----------
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
// à un module JS partagé entre pages. Contrairement à la version présente
// dans les 3 jeux, pas de rechargement de page après connexion/déconnexion
// ici : le lobby n'a aucun websocket à reconnecter, un simple rafraîchissement
// de la pastille suffit.
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
  // pastille.
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

  // Pas de websocket sur le lobby : après une connexion/inscription/
  // déconnexion réussie, on referme la modale et on rafraîchit simplement
  // la pastille (pas de rechargement de page nécessaire ici).
  function afterAuthChange() {
    loginForm.reset();
    registerForm.reset();
    closeAuthModal();
    refreshAuthFromServer();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthError(null);
    const username = document.getElementById('authLoginUsername').value;
    const password = document.getElementById('authLoginPassword').value;
    const submitBtn = loginForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const { ok, data } = await postAuthJson('/auth/login', { username, password });
    submitBtn.disabled = false;
    if (ok && data && data.ok) { afterAuthChange(); return; }
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
    submitBtn.disabled = false;
    if (ok && data && data.ok) { afterAuthChange(); return; }
    setAuthError((data && data.message) || 'Impossible de créer ce compte.');
  });

  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* on rafraîchit quand même l'état affiché */ }
    logoutBtn.disabled = false;
    afterAuthChange();
  });

  refreshAuthFromServer();
})();
