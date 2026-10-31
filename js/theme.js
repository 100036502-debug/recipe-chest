// Runs before /css/app.css is applied: set the saved theme on <html> so there is
// no flash of the wrong palette. It lives in a file, not inline in index.html,
// so the CSP can eventually drop 'unsafe-inline' for scripts.
try {
  var rcTheme = localStorage.getItem('rc_theme');
  if (rcTheme === 'light' || rcTheme === 'dark') {
    document.documentElement.dataset.theme = rcTheme;
  }
} catch (e) { /* blocked storage must not break the page */ }
