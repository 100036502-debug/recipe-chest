// Runs before the stylesheets settle, so there is no flash of the wrong
// palette. Light is the default; a pinned choice wins, otherwise the OS decides.
// It lives in a file, not inline in index.html, so the CSP keeps script-src
// 'self' without unsafe-inline.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('rc_theme'); } catch (e) { /* private mode */ }
  var dark = saved === 'dark' || (saved !== 'light' && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
