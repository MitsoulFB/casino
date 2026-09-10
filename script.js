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
