// Runs before /css/app.css is applied so there is no flash of the wrong
// palette. The app is dark only, so this no longer reads a saved choice: it
// always sets dark. It lives in a file, not inline in index.html, so the CSP can
// eventually drop 'unsafe-inline' for scripts.
document.documentElement.dataset.theme = 'dark';
