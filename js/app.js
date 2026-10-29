
const API = '/api';
const DEVICE_KEY = 'rc_device_id';

// Every API call goes through here: if the session cookie has expired,
// show the lock screen again instead of a cryptic "Failed to load".
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (res.status === 401 && !String(url).includes('/verify-code')) {
    showLockScreen('Session expired. Enter the access code.');
    throw new Error('Session expired');
  }
  return res;
}
function showLockScreen(message) {
  document.getElementById('lock-screen').style.display = 'flex';
  document.getElementById('app-content').style.display = 'none';
  document.body.classList.add('locked');
  document.getElementById('lock-err').textContent = message || '';
  const input = document.getElementById('lock-input');
  if (input) input.value = '';
}

// ---- client error reporting ------------------------------------------------
// A crash in this file is invisible on the server: the user sees a broken
// screen and the logs stay quiet. These listeners send a short report to
// /api/client-error so real failures show up in the function logs.
//
// Deliberately narrow: at most 5 per page load, nothing while the lock screen
// is up, nothing from browser-extension sources, and no known-noisy message
// (ResizeObserver fires on ordinary layout work). The reporter itself must
// never throw, or it would cause the very loop it is trying to report.
const CLIENT_ERROR_LIMIT = 5;
let clientErrorReports = 0;

function ignoreClientError(source, url) {
  return /^(chrome|moz|safari-web)-extension:\/\//i.test(String(source || '') + String(url || ''));
}

function reportClientError(payload) {
  try {
    if (clientErrorReports >= CLIENT_ERROR_LIMIT) return;
    if (/ResizeObserver loop/i.test(String(payload.message || ''))) return;
    if (ignoreClientError(payload.source, payload.url)) return;
    // Nothing to report yet if the user has not unlocked the app.
    if (document.body.classList.contains('locked')) return;

    clientErrorReports += 1;
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      // sendBeacon keeps working while the page is being torn down.
      const sent = navigator.sendBeacon('/api/client-error', new Blob([body], { type: 'application/json' }));
      if (sent) return;
    }
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => { /* nothing useful to do if the report itself fails */ });
  } catch (e) {
    /* reporting must never throw */
  }
}

window.addEventListener('error', (event) => {
  try {
    reportClientError({
      message: event.message || (event.error && event.error.message) || 'Unknown error',
      source: event.filename || '',
      line: event.lineno || 0,
      col: event.colno || 0,
      stack: (event.error && event.error.stack) || '',
      url: location.href,
    });
  } catch (e) { /* ignore */ }
});

window.addEventListener('unhandledrejection', (event) => {
  try {
    const reason = event.reason;
    reportClientError({
      message: (reason && reason.message) || String(reason || 'Unhandled promise rejection'),
      source: '',
      line: 0,
      col: 0,
      stack: (reason && reason.stack) || '',
      url: location.href,
    });
  } catch (e) { /* ignore */ }
});

// ---- History-backed overlays: the phone Back button closes the topmost
// modal instead of leaving the app. Each open overlay gets a history
// entry; closing it with its own X button pops that entry again.
const openOverlayStack = [];
const overlayFocusStack = [];
let overlayHistoryNav = false;

function overlayOpened(id) {
  // Re-renders of an already-open overlay (openDetail after save) must not
  // push a second history entry; the stack tells us if it is really new.
  if (openOverlayStack.includes(id)) return;
  openOverlayStack.push(id);
  try { history.pushState({ overlay: id }, ''); } catch (e) { /* no History API */ }
  // Accessibility: move focus into the dialog, remember where to return.
  const el = document.getElementById(id);
  if (!el) return;
  const dialog = el.querySelector('.modal, .cook-mode') || el;
  overlayFocusStack.push(document.activeElement);
  const focusables = dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
  const target = focusables.length ? focusables[0] : dialog;
  if (target && typeof target.focus === 'function') target.focus();
}

function overlayClosed(id) {
  const i = openOverlayStack.indexOf(id);
  if (i !== -1) openOverlayStack.splice(i, 1);
  // Accessibility: return focus to the element that opened the overlay.
  const prev = overlayFocusStack.pop();
  if (prev && document.contains(prev) && typeof prev.focus === 'function') {
    try { prev.focus(); } catch (e) { /* detached node */ }
  }
  if (history.state && history.state.overlay === id) {
    overlayHistoryNav = true;
    history.back(); // fires popstate, which must not close another overlay
  }
}

function closeOverlayById(id) {
  switch (id) {
    case 'upload-overlay': cancelUpload(); break;
    case 'import-overlay': closeImport(); break;
    case 'detail-overlay': closeDetail(); break;
    case 'cook-overlay': closeCookMode(); break;
    case 'shopping-overlay': closeShoppingList(); break;
    case 'pantry-overlay': closePantry(); break;
    case 'paste-overlay': closePasteImport(); break;
    case 'coll-overlay': closeCollectionsManager(); break;
    case 'cooked-overlay': closeCookedModal(); break;
    case 'plan-overlay': closeMealPlan(); break;
    case 'picker-overlay': closePicker(); break;
    case 'credit-overlay': cancelPhotoUpload(); break;
  }
}

window.addEventListener('popstate', () => {
  if (overlayHistoryNav) { overlayHistoryNav = false; return; }
  // Back was pressed: close the topmost still-open overlay.
  for (let i = openOverlayStack.length - 1; i >= 0; i--) {
    const id = openOverlayStack[i];
    const el = document.getElementById(id);
    if (el && el.classList.contains('on')) { closeOverlayById(id); return; }
    openOverlayStack.splice(i, 1); // stale entry
  }
});

const MEAL_STYLES = {
  breakfast: { bg: 'linear-gradient(135deg, #FFE066 0%, #FFA726 100%)', emoji: '🥞', label: 'Breakfast' },
  lunch:     { bg: 'linear-gradient(135deg, #A8E063 0%, #56AB2F 100%)', emoji: '🥗', label: 'Lunch' },
  dinner:    { bg: 'linear-gradient(135deg, #667EEA 0%, #764BA2 100%)', emoji: '🍽️', label: 'Dinner' },
  dessert:   { bg: 'linear-gradient(135deg, #F093FB 0%, #F5576C 100%)', emoji: '🍰', label: 'Dessert' },
  snack:     { bg: 'linear-gradient(135deg, #4FACFE 0%, #00F2FE 100%)', emoji: '🍪', label: 'Snack' },
  drink:     { bg: 'linear-gradient(135deg, #43C6AC 0%, #191654 100%)', emoji: '☕', label: 'Drink' },
  default:   { bg: 'linear-gradient(135deg, #C7541A 0%, #5A3A22 100%)', emoji: '📖', label: 'Recipe' },
};
function mealStyle(t) { return MEAL_STYLES[t] || MEAL_STYLES.default; }
function cardPhotoSrc(r) {
  if (r.userPhoto) return `/api/photo?id=${encodeURIComponent(r.id)}&size=thumb&v=${r.userPhoto.updatedAt}`;
  return (r.image && (r.image.thumb || r.image.url)) || '';
}
// One place for the hero photo markup: the user's own photo (with its
// credit), then the Unsplash photo (with attribution), then the emoji.
function heroPhotoHtml(r, ms) {
  if (r.userPhoto) {
    return `<img class="hero-img" src="/api/photo?id=${encodeURIComponent(r.id)}&amp;v=${r.userPhoto.updatedAt}" alt="${escapeHtml(r.title)}" onerror="this.outerHTML='<span>${ms.emoji}</span>'">` +
      (r.userPhoto.credit ? `<div class="img-credit">${escapeHtml(r.userPhoto.credit)}</div>` : '');
  }
  if (r.image && r.image.url) {
    return `<img class="hero-img" src="${escapeHtml(r.image.url)}" alt="${escapeHtml(r.image.alt || r.title)}" onerror="this.outerHTML='<span>${ms.emoji}</span>'">` +
      `<div class="img-credit">Photo by ${(r.image.photographerUrl && safeHref(r.image.photographerUrl)) ? `<a href="${escapeHtml(safeHref(r.image.photographerUrl))}" target="_blank" rel="noopener">${escapeHtml(r.image.photographer || 'Unknown')}</a>` : escapeHtml(r.image.photographer || 'Unknown')} on <a href="https://unsplash.com/?utm_source=recipe_chest&amp;utm_medium=referral" target="_blank" rel="noopener">Unsplash</a></div>`;
  }
  return `<span>${ms.emoji}</span>`;
}
// Scales the leading amount of one ingredient line (shared by the detail
// view and cook mode). Returns the full line text, HTML-escaped.
// Fraction characters (½ ¼ ¾ ⅓ ⅔ ⅛) are converted to decimals first so
// "1½ cups" and "½ tsp" scale too; scaleAmount writes the result via
// formatAmount() (nicest fraction form).
const FRACTION_CHARS = { '½': 1/2, '¼': 1/4, '¾': 3/4, '⅓': 1/3, '⅔': 2/3, '⅛': 1/8 };
function scaleIngredientLine(ing, factor) {
  if (factor === 1) return escapeHtml(ing);
  // Merge a preceding whole number INTO the fraction ("2 ½" -> 2.5, then
  // formatAmount renders "2 1/2"). Returning "2 0.5" left scaleAmount
  // with a string it could not parse, so nothing was scaled.
  const s = String(ing).replace(/(\d*)\s*([½¼¾⅓⅔⅛])/g, (_, whole, frac) => {
    const value = (whole ? parseInt(whole, 10) : 0) + FRACTION_CHARS[frac];
    return formatAmount(value);
  });
  const m = s.match(/^([\d/.\s]+)\s+(.*)$/);
  if (!m) return escapeHtml(ing);
  const scaled = scaleAmount(m[1].trim(), factor);
  return `${escapeHtml(scaled)} ${escapeHtml(m[2])}`;
}

let recipes = [];
let currentFilter = 'all';
let currentMealFilter = 'all';
let currentSort = 'newest';
let showAllTags = false;
let currentSearch = '';
let uploadQueue = [];
let isProcessing = false;
let cancelRequested = false;
let shoppingList = { items: [] };
let mealPlan = {};
// 'unknown' until a load actually succeeds. Anything but 'ok' means we do not
// know what the server holds, so we must not write over it.
let shoppingListState = 'unknown';
let mealPlanState = 'unknown';
let planWeekOffset = 0;
let currentScaling = null;
let offlineMode = false; // true when showing cached recipes (read-only)

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

async function tryUnlock() {
  const val = document.getElementById('lock-input').value;
  const err = document.getElementById('lock-err');
  err.textContent = '';
  if (!val) { err.textContent = 'Enter the access code.'; return; }
  try {
    const res = await fetch(`${API}/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: val }),
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data && data.unlocked) unlockApp();
        else { err.textContent = (data && data.error) || 'Incorrect access code.'; document.getElementById('lock-input').value = ''; }
  } catch (e) { err.textContent = 'Could not verify. Try again.'; }
}
// PWA shortcuts: /?action=add opens the upload dialog, ?action=import the URL import
function handleAppShortcut() {
  const action = new URLSearchParams(location.search).get('action');
  if (!action) return;
  history.replaceState({}, '', '/');
  if (action === 'add' && document.getElementById('app-content').style.display !== 'none') openUpload();
  else if (action === 'import' && document.getElementById('app-content').style.display !== 'none') openImport();
}
function unlockApp() {
  // Close whatever overlay was open when the session expired so the
  // app comes back clean.
  for (const id of ['upload-overlay', 'import-overlay', 'detail-overlay', 'shopping-overlay', 'plan-overlay', 'picker-overlay']) {
    if (document.getElementById(id).classList.contains('on')) closeOverlayById(id);
  }
  if (document.getElementById('cook-overlay').classList.contains('on')) closeCookMode();
  document.getElementById('lock-screen').style.display = 'none';
  document.getElementById('app-content').style.display = 'flex';
  document.body.classList.remove('locked');
  setUser(getUser());
  getDeviceId();
  loadRecipes();
  handleAppShortcut();
  document.dispatchEvent(new Event('recipe-chest:unlocked'));
}
document.getElementById('lock-input').addEventListener('keypress', e => { if (e.key === 'Enter') tryUnlock(); });
(async function checkSession() {
  try {
    const res = await fetch(`${API}/verify-code`, { credentials: 'same-origin' });
    const data = await res.json();
    if (data && data.unlocked) { unlockApp(); return; }
  } catch (e) {}
  const input = document.getElementById('lock-input');
  if (input) input.focus();
})();

// unlockApp can be reached from the session check and from the unlock form, so
// hook it once rather than patching both call sites.
document.addEventListener('recipe-chest:unlocked', () => setTimeout(applyPendingShare, 0));

let toastActionHandler = null;
function clearToastAction() {
  const t = document.getElementById('toast');
  t.onclick = null;
  t.style.pointerEvents = '';
  t.style.cursor = '';
}

function toast(msg) {
  const t = document.getElementById('toast');
  clearToastAction();
  t.textContent = msg;
  toastActionHandler = null;
  t.classList.add('on');
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.classList.remove('on'), 2800);
}
// A toast with one action button (used for Undo). The handler is cleared as
// soon as the toast goes away, so a stale tap cannot act on something else.
function toastWithUndo(message, label, onUndo, ms = 10000) {
  const t = document.getElementById('toast');
  clearToastAction();
  t.innerHTML = `${escapeHtml(message)} <button type="button" class="toast-action" id="toast-action">${escapeHtml(label)}</button>`;
  t.classList.add('on');
  clearTimeout(t._timeout);
  toastActionHandler = typeof onUndo === 'function' ? onUndo : null;
  t._timeout = setTimeout(() => {
    t.classList.remove('on');
    toastActionHandler = null;
  }, ms);
}
document.getElementById('toast').addEventListener('click', e => {
  if (!e.target.closest('#toast-action')) return;
  const t = document.getElementById('toast');
  const fn = toastActionHandler;
  toastActionHandler = null;
  clearTimeout(t._timeout);
  t.classList.remove('on');
  if (fn) fn();
});
function toggleAppMenu() {
  document.getElementById('app-menu').classList.toggle('on');
}
function closeAppMenu() {
  document.getElementById('app-menu').classList.remove('on');
}
document.addEventListener('click', e => {
  const menu = document.getElementById('app-menu');
  if (menu && menu.classList.contains('on') && !e.target.closest('.menu-wrap')) closeAppMenu();
});
function downloadBlobAs(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportBackup(withPhotos) {
  closeAppMenu();
  const date = new Date().toISOString().slice(0, 10);
  try {
    // 1. Recipes-only file, exactly as before.
    const res = await apiFetch(`${API}/export`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Export failed');
    downloadBlobAs(await res.blob(), `recipe-chest-backup-${date}.json`);
    if (!withPhotos) { toast('Backup downloaded'); return; }

    // 2. Photos, one slice per file so no response hits the size limit.
    let offset = 0;
    let part = 0;
    for (;;) {
      const res = await apiFetch(`${API}/export?photos=1&offset=${offset}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast('Could not export photos: ' + (data.error || 'Export failed') + '. Try "Export backup" (without photos).');
        return;
      }
      const slice = await res.json();
      const ids = Object.keys(slice.photos || {});
      if (ids.length || slice.done) {
        part++;
        downloadBlobAs(new Blob([JSON.stringify(slice)], { type: 'application/json' }),
          `recipe-chest-photos-${date}-part${part}.json`);
      }
      if (slice.done) break;
      offset = slice.nextOffset;
      toast(`Exporting photos... part ${part + 1}`);
    }
    toast(`Backup downloaded${part > 1 ? ` (${part} photo parts)` : ' (with photos)'}`);
  } catch (e) {
    toast('Could not export: ' + e.message + '. Try "Export backup" (without photos).');
  }
}

// ---- Restore backup: pick the exported JSON file(s), recipes first ----
const BACKUP_FILE_MAX_BYTES = 3.75 * 1024 * 1024; // below the 4 MB bodyParser limit and Vercel's ~4.5 MB cap
function pickBackupFiles() {
  closeAppMenu();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.multiple = true;
  input.onchange = () => restoreBackupFiles(input.files && [...input.files]);
  input.click();
}
async function restoreBackupFiles(files) {
  if (!files || !files.length) return;
  const tooBig = files.find((f) => f.size > BACKUP_FILE_MAX_BYTES);
  if (tooBig) { toast(`"${tooBig.name}" is too large (${(tooBig.size / 1048576).toFixed(1)} MB). Export smaller parts.`); return; }

  // Recipes files first, then photo slices.
  const parsed = [];
  for (const f of files) {
    try {
      parsed.push(await f.text().then(JSON.parse));
    } catch (e) {
      toast(`"${f.name}" is not a valid backup file.`);
      return;
    }
  }
  const recipesFiles = parsed.filter((p) => Array.isArray(p.recipes) && p.recipes.length);
  const photoFiles = parsed.filter((p) => !Array.isArray(p.recipes) && p.photos);
  const ordered = [...recipesFiles, ...photoFiles];

  let imported = 0, skipped = 0, photosRestored = 0;
  for (const payload of ordered) {
    try {
      const res = await apiFetch(`${API}/import-backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || 'Restore failed');
      imported += data.imported || 0;
      skipped += data.skipped || 0;
      photosRestored += data.photosRestored || 0;
    } catch (e) {
      toast('Restore failed: ' + e.message);
      return;
    }
  }
  toast(`Restored ${imported} recipe${imported === 1 ? '' : 's'}, skipped ${skipped}${photosRestored ? `, ${photosRestored} photo${photosRestored === 1 ? '' : 's'}` : ''}`);
  await loadRecipes();
}
async function lockApp() {
  try { await apiFetch(`${API}/verify-code`, { method: 'DELETE' }); } catch (e) { /* already locked */ }
  showLockScreen('Locked. Enter the access code.');
}
function getUser() { return localStorage.getItem('rc_user') || 'Anonymous'; }
function setUser(name) {
  localStorage.setItem('rc_user', name || 'Anonymous');
  document.getElementById('user-tag').textContent = '👤 ' + (name || 'Anonymous');
}
// Only http(s) URLs may become hrefs; anything stored weirdly renders as text.
function safeHref(u) {
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : ''; }
  catch { return ''; }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function detectMealType(tags) {
  if (!Array.isArray(tags)) return null;
  const joined = tags.join(' ').toLowerCase();
  const checks = [
    ['breakfast', /\b(breakfast|brunch|morning)\b/],
    ['lunch', /\b(lunch|midday)\b/],
    ['dinner', /\b(dinner|supper|entree|main)\b/],
    ['dessert', /\b(dessert|sweet|cake|cookie|pie)\b/],
    ['snack', /\b(snack|appetizer|starter)\b/],
    ['drink', /\b(drink|beverage|cocktail|smoothie)\b/],
  ];
  for (const [type, re] of checks) if (re.test(joined)) return type;
  return null;
}

function scaleAmount(amountStr, factor) {
  if (factor === 1) return amountStr;
  const s = String(amountStr || '').trim();
  if (!s) return amountStr;
  const range = s.match(/^(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*[-–]\s*(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)$/);
  if (range) return `${scaleAmount(range[1], factor)}–${scaleAmount(range[2], factor)}`;
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const val = parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
    return formatAmount(val * factor);
  }
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const val = parseInt(frac[1]) / parseInt(frac[2]);
    return formatAmount(val * factor);
  }
  const num = s.match(/^(\d+(?:\.\d+)?)$/);
  if (num) return formatAmount(parseFloat(num[1]) * factor);
  return amountStr;
}
function formatAmount(n) {
  if (!isFinite(n) || n <= 0) return '';
  if (Math.abs(n - Math.round(n)) < 0.01) return String(Math.round(n));
  const whole = Math.floor(n);
  const frac = n - whole;
  const common = [[1/8, '1/8'], [1/4, '1/4'], [1/3, '1/3'], [1/2, '1/2'], [2/3, '2/3'], [3/4, '3/4']];
  for (const [val, label] of common) {
    if (Math.abs(frac - val) < 0.03) return whole > 0 ? `${whole} ${label}` : label;
  }
  return n.toFixed(2).replace(/\.?0+$/, '');
}

async function compressImage(file, maxDim = 1200, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height >= width && height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
      };
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function openUpload() {
  document.getElementById('upload-overlay').classList.add('on');
  overlayOpened('upload-overlay');
  document.getElementById('uploader-name').value = getUser() === 'Anonymous' ? '' : getUser();
  updateQueueUI();
}
function cancelUpload() {
  if (isProcessing) {
    if (!confirm('Stop processing the remaining images? Already-saved recipes will stay.')) return; // keep going: overlay stays open, history entry intact
    cancelRequested = true;
  }
  // Only pop the history entry / restore focus once the overlay really closes.
  overlayClosed('upload-overlay');
  document.getElementById('upload-overlay').classList.remove('on');
  for (const item of uploadQueue) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  uploadQueue = [];
  isProcessing = false;
  cancelRequested = false;
  updateQueueUI();
}
const dz = document.getElementById('dropzone');
const fi = document.getElementById('file-input');
dz.addEventListener('click', () => { if (!isProcessing) fi.click(); });
dz.addEventListener('dragover', (e) => { e.preventDefault(); if (!isProcessing) dz.classList.add('dragover'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('dragover');
  if (isProcessing) return;
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) addFilesToQueue(files);
});
fi.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length) addFilesToQueue(files);
  fi.value = '';
});
// Queue-row buttons are delegated, so a re-render never loses the handler.
document.getElementById('queue-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-queue-action]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.queueId;
  if (btn.dataset.queueAction === 'retry') retryItem(id);
  else if (btn.dataset.queueAction === 'open') openQueuedRecipe(id);
  else if (btn.dataset.queueAction === 'copy') saveCopyAnyway(id);
});
const MAX_PDF_UPLOAD_BYTES = 3 * 1024 * 1024; // Vercel caps request bodies at ~4.5 MB
function addFilesToQueue(files) {
  const status = document.getElementById('upload-status');
  status.textContent = '';
  status.classList.remove('error');
  let skipped = 0;
  const added = [];
  for (const file of files) {
    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isImage && !isPdf) { skipped++; continue; }
    if (isImage && file.size > 25 * 1024 * 1024) { skipped++; continue; }
    if (isPdf && file.size > MAX_PDF_UPLOAD_BYTES) { skipped++; continue; }
    uploadQueue.push({
      id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      file, isPdf, previewUrl: isImage ? URL.createObjectURL(file) : null,
      base64: null, mimeType: null, status: 'ready', error: null,
      recipeId: null, title: null, originalName: file.name,
    });
    added.push(file);
  }
  if (skipped > 0) status.textContent = `${skipped} file${skipped > 1 ? 's' : ''} skipped`;
  if (added.length > 0) toast(`Added ${added.length} file${added.length > 1 ? 's' : ''}`);
  updateQueueUI();
}
// Raw file to base64 (used for PDFs, which are not recompressed client-side)
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
// Which endpoint and body a queued item needs. Pure: no DOM, no uploads.
// A PDF goes to /api/process-pdf as raw base64; an image goes to /api/process
// after client-side compression.
function buildImportRequest(item, name, base64, mimeType) {
  if (item.isPdf) {
    return {
      path: '/api/process-pdf',
      body: { pdfBase64: base64, addedBy: name, skipDuplicateCheck: item.skipDuplicateCheck === true },
    };
  }
  return {
    path: '/api/process',
    body: { imageBase64: base64, mimeType, addedBy: name, skipDuplicateCheck: item.skipDuplicateCheck === true },
  };
}
// Map an import response to a queue state. Pure: takes the status code and the
// parsed body, returns what updateQueueUI() should show.
// A 409 with a duplicate payload is NOT a failure — it is a recipe we already have.
function importOutcome(status, data) {
  const body = data && typeof data === 'object' ? data : {};
  if (status >= 200 && status < 300) {
    return { state: 'done', recipeId: body.id || null, title: body.title || 'Saved', message: '' };
  }
  if (status === 409 && body.duplicate && body.duplicate.id) {
    return {
      state: 'duplicate',
      recipeId: body.duplicate.id,
      title: body.duplicate.title || '',
      message: body.error || 'Already in your chest',
    };
  }
  return { state: 'failed', recipeId: null, title: '', message: body.error || `Failed (HTTP ${status})` };
}
// "3 images + 1 PDF in queue" rather than calling every item an image.
function queueCountLabel(items) {
  const total = items.length;
  const pdfs = items.filter(i => i.isPdf).length;
  const images = total - pdfs;
  const part = (n, word, plural) => `${n} ${n === 1 ? word : plural}`;
  if (!pdfs) return `${part(images, 'image', 'images')} in queue`;
  if (!images) return `${part(pdfs, 'PDF', 'PDFs')} in queue`;
  return `${part(images, 'image', 'images')} + ${part(pdfs, 'PDF', 'PDFs')} in queue`;
}
function updateQueueUI() {
  const wrap = document.getElementById('queue-wrap');
  const list = document.getElementById('queue-list');
  const count = document.getElementById('queue-count');
  const progress = document.getElementById('queue-progress');
  const btn = document.getElementById('process-btn');
  const dropzone = document.getElementById('dropzone');
  const dzText = document.getElementById('dz-text');
  const cancelBtn = document.getElementById('upload-cancel-btn');
  if (uploadQueue.length === 0) {
    wrap.classList.remove('on');
    dropzone.style.display = 'block';
    dzText.innerHTML = '<strong>Click to add images or PDFs</strong> or drag &amp; drop them here';
    btn.disabled = true;
    btn.textContent = 'Save All to Chest';
    cancelBtn.textContent = 'Close';
    return;
  }
  wrap.classList.add('on');
  dropzone.style.display = isProcessing ? 'none' : 'block';
  if (!isProcessing) dzText.innerHTML = '<strong>Click to add more</strong> images or PDFs';
  const total = uploadQueue.length;
  const done = uploadQueue.filter(i => i.status === 'done').length;
  const failed = uploadQueue.filter(i => i.status === 'failed').length;
  const dupes = uploadQueue.filter(i => i.status === 'duplicate').length;
  const ready = uploadQueue.filter(i => i.status === 'ready').length;
  count.textContent = queueCountLabel(uploadQueue);
  updateOneRecipeControl();
  if (isProcessing) {
    progress.textContent = `${done + failed + dupes} / ${total} processed`;
    btn.disabled = true;
    btn.textContent = 'Processing...';
    cancelBtn.textContent = 'Stop';
  } else if (ready === 0 && total === done + failed + dupes) {
    progress.textContent = `Done: ${done} saved${dupes ? `, ${dupes} already in your chest` : ''}${failed ? `, ${failed} failed` : ''}`;
    btn.disabled = true;
    btn.textContent = 'All Done';
    cancelBtn.textContent = 'Close';
  } else {
    progress.textContent = `${ready} ready to save${done + failed > 0 ? ` • ${done + failed} already done` : ''}`;
    btn.disabled = false;
    btn.textContent = `Save ${ready} to Chest`;
    cancelBtn.textContent = 'Close';
  }
  list.innerHTML = uploadQueue.map(item => {
    let badge = '';
    switch (item.status) {
      case 'ready': badge = 'Ready'; break;
      case 'processing': badge = '<span class="spinner"></span>Reading...'; break;
      case 'done': badge = '✓ ' + (item.title ? escapeHtml(item.title) : 'Saved'); break;
      case 'duplicate': badge = '📖 Already in your chest' + (item.title ? ': ' + escapeHtml(item.title) : ''); break;
      case 'failed': badge = '⚠ ' + escapeHtml((item.error || 'Failed').slice(0, 100)); break;
    }
    let actions = '';
    if (item.status === 'failed') actions = `<button class="queue-retry" data-queue-action="retry" data-queue-id="${item.id}">Retry</button>`;
    else if (item.status === 'duplicate') actions = `<button class="queue-retry queue-open" data-queue-action="open" data-queue-id="${item.id}">Open</button><button class="queue-retry" data-queue-action="copy" data-queue-id="${item.id}"${isProcessing ? ' disabled' : ''}>Save a copy</button>`;
    const name = item.title ? escapeHtml(item.title) : escapeHtml(item.originalName || 'Image');
    return `<div class="queue-item ${item.status}">${item.previewUrl ? `<img class="queue-thumb" src="${item.previewUrl}" alt="">` : `<span class="queue-thumb queue-pdf" aria-hidden="true">📄</span>`}<div class="queue-info"><div class="queue-name">${name}</div><div class="queue-badge">${badge}</div></div>${actions}</div>`;
  }).join('');
  if (isProcessing) list.scrollTop = list.scrollHeight;
}
function retryItem(id) {
  const item = uploadQueue.find(i => i.id === id);
  if (!item || isProcessing) return;
  item.status = 'ready';
  item.error = null;
  updateQueueUI();
}
// Open the recipe we already have, straight from a duplicate queue row.
function openQueuedRecipe(queueItemId) {
  const item = uploadQueue.find(i => i.id === queueItemId);
  if (!item || !item.recipeId) return;
  if (recipes.some(r => r.id === item.recipeId)) { openDetail(item.recipeId); return; }
  loadRecipes().then(() => openDetail(item.recipeId));
}
// "Save a copy" on a duplicate: re-queue it with the duplicate check off.
function saveCopyAnyway(queueItemId) {
  const item = uploadQueue.find(i => i.id === queueItemId);
  if (!item || isProcessing) return;
  item.status = 'ready';
  item.skipDuplicateCheck = true;
  item.error = null;
  updateQueueUI();
  startBatch();
}
// ---- multi-photo import: photos of one recipe sent as one request ----
function oneRecipeChecked() {
  const cb = document.getElementById('one-recipe');
  return !!(cb && cb.checked);
}
function updateOneRecipeControl() {
  const wrap = document.getElementById('one-recipe-wrap');
  const note = document.getElementById('one-recipe-note');
  const btn = document.getElementById('process-btn');
  if (!wrap) return;
  const countable = uploadQueue.filter(i => !i.isPdf && i.status !== 'removed');
  const ready = countable.filter(i => i.status === 'ready' || i.status === 'failed');
  wrap.style.display = countable.length >= 2 ? 'flex' : 'none';
  const over = oneRecipeChecked() && countable.length > 3;
  if (note) {
    note.style.display = over ? 'block' : 'none';
    note.textContent = over ? 'Only 3 photos can be combined into one recipe. Remove some first.' : '';
  }
  if (btn && over) btn.disabled = true;
  if (btn && !over && ready.length) btn.disabled = false;
}
async function processAsOneRecipe(items, name) {
  const group = items.slice(0, 3);
  group.forEach(i => { i.status = 'processing'; i.error = null; });
  updateQueueUI();
  try {
    const prepared = [];
    for (const item of group) {
      let base64 = item.base64, mime = item.mimeType;
      if (!base64) {
        const compressed = await compressImage(item.file, 1000, 0.8);
        base64 = compressed.base64; mime = compressed.mimeType;
        item.base64 = base64; item.mimeType = mime;
      }
      prepared.push({ imageBase64: base64, mimeType: mime });
    }
    const plan = RCUtils.buildMultiImageRequest(prepared, name);
    if (plan.error) throw new Error(plan.error);
    const res = await apiFetch(plan.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(plan.body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 409) {
      group.forEach(i => { i.status = 'duplicate'; i.error = null; });
      updateQueueUI();
      return;
    }
    if (!res.ok) throw new Error((data && data.error) || 'Import failed');
    const saved = (data && data.recipe) || data || {};
    group.forEach(i => {
      i.status = 'done';
      i.recipeId = saved.id;
      i.title = saved.title || 'Saved';
      i.base64 = null;
      i.file = null;
    });
    if (saved.id && !recipes.some(r => r.id === saved.id)) recipes.push(saved);
    renderGrid();
  } catch (e) {
    group.forEach(i => { i.status = 'failed'; i.error = e.message; });
  }
  updateQueueUI();
}

async function startBatch() {
  if (isProcessing) return;
  let ready = uploadQueue.filter(i => i.status === 'ready');
  if (!ready.length) return;
  const name = document.getElementById('uploader-name').value.trim() || 'Anonymous';
  setUser(name);
  isProcessing = true;
  cancelRequested = false;
  updateQueueUI();
  let success = 0, failed = 0, duplicates = 0;
  // Grouped import: up to 3 photos of one recipe go out as a single request.
  if (oneRecipeChecked() && ready.filter(i => !i.isPdf).length >= 2) {
    await processAsOneRecipe(ready.filter(i => !i.isPdf), name);
    ready = uploadQueue.filter(i => i.status === 'ready');
    if (!ready.length) { isProcessing = false; updateQueueUI(); return; }
  }
  for (const item of ready) {
    if (cancelRequested) break;
    item.status = 'processing';
    updateQueueUI();
    try {
      // Base64 is cached on the queue item, so a retry does not re-read the file.
      let base64 = item.base64;
      let mime = item.mimeType;
      if (!base64) {
        if (item.isPdf) {
          // A PDF is sent as-is; it must never go through the image compressor.
          base64 = await fileToBase64(item.file);
          mime = 'application/pdf';
        } else {
          const compressed = await compressImage(item.file);
          base64 = compressed.base64;
          mime = compressed.mimeType;
        }
        item.base64 = base64;
        item.mimeType = mime;
      }
      const plan = buildImportRequest(item, name, base64, mime);
      const res = await apiFetch(plan.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(plan.body),
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      const outcome = importOutcome(res.status, data);
      if (outcome.state === 'done') {
        item.status = 'done';
        item.recipeId = outcome.recipeId;
        item.title = outcome.title || 'Saved';
        item.file = null;
        item.base64 = null;
        item.skipDuplicateCheck = false;
        success++;
      } else if (outcome.state === 'duplicate') {
        // Not a failure: we already have this recipe. Keep the cached base64 so
        // "Save a copy" can re-send it without reading the file again.
        item.status = 'duplicate';
        item.recipeId = outcome.recipeId;
        item.title = outcome.title;
        item.error = null;
        duplicates++;
      } else {
        throw new Error(outcome.message);
      }
    } catch (err) {
      item.status = 'failed';
      item.error = err.message;
      failed++;
    }
    updateQueueUI();
    if (!cancelRequested && uploadQueue.filter(i => i.status === 'ready').length > 0) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  isProcessing = false;
  cancelRequested = false;
  updateQueueUI();
  await loadRecipes();
  const parts = [];
  if (success) parts.push(`${success} saved`);
  if (duplicates) parts.push(`${duplicates} already in your chest`);
  if (failed) parts.push(`${failed} failed`);
  if (!parts.length) return;
  toast(parts.join(', ') + (failed ? '. Click Retry on failures.' : '!'));
}

function openImport() {
  document.getElementById('import-overlay').classList.add('on');
  overlayOpened('import-overlay');
  document.getElementById('importer-name').value = getUser() === 'Anonymous' ? '' : getUser();
  document.getElementById('import-url').value = '';
  document.getElementById('import-status').textContent = '';
  document.getElementById('import-status').classList.remove('error');
  document.getElementById('import-url').focus();
}
function closeImport() { document.getElementById('import-overlay').classList.remove('on'); overlayClosed('import-overlay'); }
async function processImport() {
  const url = document.getElementById('import-url').value.trim();
  const name = document.getElementById('importer-name').value.trim() || 'Anonymous';
  const status = document.getElementById('import-status');
  const btn = document.getElementById('import-btn');
  if (!url) { status.textContent = 'Please enter a URL.'; status.classList.add('error'); return; }
  if (!/^https?:\/\//i.test(url)) { status.textContent = 'URL must start with http:// or https://'; status.classList.add('error'); return; }
  btn.disabled = true;
  status.classList.remove('error');
  status.innerHTML = '<span class="spinner"></span>Fetching page and reading the recipe...';
  try {
    const res = await apiFetch(`${API}/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ url, addedBy: name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    setUser(name);
    toast('Recipe imported!');
    closeImport();
    await loadRecipes();
    openDetail(data.id);
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('error');
    btn.disabled = false;
  }
}
document.getElementById('import-url').addEventListener('keypress', e => { if (e.key === 'Enter') processImport(); });

async function loadRecipes() {
  try {
    const res = await apiFetch(`${API}/recipes`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Failed to load');
    recipes = await res.json();
    offlineMode = false;
    try { localStorage.setItem('rc_recipes_cache', JSON.stringify(recipes)); } catch (e) { /* storage full */ }
    renderGrid();
  } catch (e) {
    // Network failure (not a 401): fall back to the last saved recipes
    // and show them read-only, so offline still works.
    if (e.message !== 'Session expired') {
      try {
        const cached = JSON.parse(localStorage.getItem('rc_recipes_cache') || '[]');
        if (Array.isArray(cached) && cached.length) {
          recipes = cached;
          offlineMode = true;
          renderGrid();
          return;
        }
      } catch (e2) { /* corrupt cache */ }
    }
    console.error(e);
    document.getElementById('grid').innerHTML = '';
    document.getElementById('empty').style.display = 'block';
    document.getElementById('empty').querySelector('h2').textContent = 'Could not load recipes';
    document.getElementById('empty').querySelector('p').textContent = e.message;
  }
}

// Total prep+cook time in minutes, or -1 when the recipe has no times
// (those always sort last under 'Quickest').
function timeToMinutes(s) {
  const str = String(s || '').toLowerCase();
  if (!str) return -1;
  let total = 0, found = false;
  const re = /(\d+(?:\.\d+)?)\s*(hour|hr|h\b|minute|min|m\b)?/g;
  let m;
  while ((m = re.exec(str))) {
    const n = parseFloat(m[1]);
    if (!m[2] || /^h/.test(m[2])) total += m[2] && /^h/.test(m[2]) ? n * 60 : n;
    else total += n;
    found = true;
  }
  return found ? total : -1;
}
function totalTimeMinutes(r) {
  const p = timeToMinutes(r.prepTime), c = timeToMinutes(r.cookTime);
  if (p >= 0 && c >= 0) return p + c;
  return Math.max(p, c); // -1 when neither parses
}
const SORTERS = {
  newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  az: (a, b) => String(a.title || '').localeCompare(String(b.title || '')),
  recently: (a, b) => {
    const sa = RCUtils.cookStats(a.cookLog), sb = RCUtils.cookStats(b.cookLog);
    if (!sa.lastDate && !sb.lastDate) return (b.createdAt || 0) - (a.createdAt || 0);
    if (!sa.lastDate) return 1;
    if (!sb.lastDate) return -1;
    return sa.lastDate < sb.lastDate ? 1 : sa.lastDate > sb.lastDate ? -1 : 0;
  },
  toprated: (a, b) => {
    const ra = RCUtils.cookStats(a.cookLog).avgRating;
    const rb = RCUtils.cookStats(b.cookLog).avgRating;
    if (ra == null && rb == null) return (b.createdAt || 0) - (a.createdAt || 0);
    if (ra == null) return 1;
    if (rb == null) return -1;
    return rb - ra;
  },
  quickest: (a, b) => {
    const ta = totalTimeMinutes(a), tb = totalTimeMinutes(b);
    if (ta === -1 && tb === -1) return (b.createdAt || 0) - (a.createdAt || 0);
    if (ta === -1) return 1;
    if (tb === -1) return -1;
    return ta - tb;
  },
};

function renderGrid() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const stats = document.getElementById('stats');
  const banner = document.getElementById('offline-banner');
  if (banner) banner.style.display = offlineMode ? 'block' : 'none';
  document.body.classList.toggle('offline', offlineMode);
  const allTags = new Map();
  recipes.forEach(r => (r.tags || []).forEach(t => allTags.set(t, (allTags.get(t) || 0) + 1)));
  let filtered = recipes;
  if (currentCollection !== 'all') filtered = filtered.filter(r => (r.collections || []).includes(currentCollection));
  if (currentFilter === 'favorites') filtered = filtered.filter(r => r.favorite === true);
  else if (currentFilter === 'never') filtered = filtered.filter(r => !(r.cookLog || []).length);
  else if (currentFilter !== 'all') filtered = filtered.filter(r => (r.tags || []).includes(currentFilter));
  if (currentMealFilter !== 'all') filtered = filtered.filter(r => r.mealType === currentMealFilter);
  if (currentSearch) {
    const q = currentSearch.toLowerCase();
    filtered = filtered.filter(r => {
      const hay = (r.title + ' ' + r.description + ' ' + (r.ingredients || []).join(' ') + ' ' + (r.tags || []).join(' ')).toLowerCase();
      return hay.includes(q);
    });
  }
  const sorted = [...filtered].sort(SORTERS[currentSort] || SORTERS.newest);

  // Sort dropdown next to the recipe count
  let statHtml = `<span>${recipes.length} recipe${recipes.length === 1 ? '' : 's'}</span>`;
  statHtml += `<select class="sort-select" onchange="setSort(this.value)" aria-label="Sort recipes">` +
    ['newest', 'oldest', 'az', 'quickest', 'recently', 'toprated'].map(s =>
      `<option value="${s}"${currentSort === s ? ' selected' : ''}>${({ newest: 'Newest', oldest: 'Oldest', az: 'A to Z', quickest: 'Quickest', recently: 'Recently cooked', toprated: 'Top rated' })[s]}</option>`
    ).join('') + `</select>`;

  if (recipes.length) {
    statHtml += `<span style="color:var(--border)">•</span>`;
    statHtml += `<span class="filter-chip ${currentFilter === 'all' ? 'on' : ''}" onclick="setFilter('all')">all</span>`;
    if (recipes.some(r => r.favorite)) {
      statHtml += `<span class="filter-chip ${currentFilter === 'favorites' ? 'on' : ''}" onclick="setFilter('favorites')">♥</span>`;
    }
    // Meal-type filter chips, only for types that are actually in use
    for (const m of Object.keys(MEAL_STYLES)) {
      if (m === 'default') continue;
      if (!recipes.some(r => r.mealType === m)) continue;
      statHtml += `<span class="filter-chip ${currentMealFilter === m ? 'on' : ''}" onclick="setMealFilter('${m}')" data-meal="${m}">${MEAL_STYLES[m].emoji} ${MEAL_STYLES[m].label}</span>`;
    }
    if (recipes.some(r => !(r.cookLog || []).length)) {
      statHtml += `<span class="filter-chip ${currentFilter === 'never' ? 'on' : ''}" onclick="setFilter('never')">Never cooked</span>`;
    }
    // Tag chips: most used first, top 12, rest behind a "more" toggle
    const tagList = [...allTags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shownTags = showAllTags ? tagList : tagList.slice(0, 12);
    for (const [t] of shownTags) {
      statHtml += `<span class="filter-chip ${currentFilter === t ? 'on' : ''}" data-tag="${escapeHtml(t)}" onclick="setFilter(this.dataset.tag)">${escapeHtml(t)}</span>`;
    }
    if (tagList.length > 12) {
      statHtml += `<span class="filter-chip" onclick="toggleShowAllTags()">${showAllTags ? '− less' : `+ ${tagList.length - 12} more`}</span>`;
    }
  }
  // Collections row: "All" plus a chip per collection, with a manage dialog.
  const collCounts = new Map();
  recipes.forEach((r) => (r.collections || []).forEach((c) => collCounts.set(c, (collCounts.get(c) || 0) + 1)));
  if (collCounts.size) {
    const names = [...collCounts.keys()].sort((a, b) => a.localeCompare(b));
    statHtml += `<div class="coll-row">` +
      `<span class="coll-row-label">Collections:</span>` +
      `<span class="filter-chip ${currentCollection === 'all' ? 'on' : ''}" onclick="setCollectionFilter('all')">All</span>` +
      names.map((c) => `<span class="filter-chip ${currentCollection === c ? 'on' : ''}" data-coll="${escapeHtml(c)}" onclick="setCollectionFilter(this.dataset.coll)">${escapeHtml(c)}<span class="coll-count">${collCounts.get(c)}</span></span>`).join('') +
      `<button class="coll-manage" onclick="openCollectionsManager()">Manage</button></div>`;
  }
  stats.innerHTML = statHtml;
  if (!filtered.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    if (recipes.length === 0) {
      empty.querySelector('h2').textContent = 'The chest is empty';
      empty.querySelector('p').textContent = 'Upload photos of recipes or import them from a website.';
    } else {
      empty.querySelector('h2').textContent = 'No matches';
      empty.querySelector('p').textContent = 'Try a different search or filter.';
    }
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = sorted.map(r => {
    const ms = mealStyle(r.mealType);
    return `
      <div class="card" onclick="openDetail('${r.id}')" tabindex="0" role="button" aria-label="${escapeHtml(r.title)}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openDetail('${r.id}')}">
        <div class="card-meal" style="background:${ms.bg}">
          <button class="fav-btn ${r.favorite === true ? 'on' : ''}" onclick="event.stopPropagation(); toggleFavorite('${r.id}')" aria-label="${r.favorite === true ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${r.favorite === true ? 'true' : 'false'}">${r.favorite === true ? '♥' : '♡'}</button>${r.userPhoto || (r.image && (r.image.thumb || r.image.url)) ? `<img class="card-img" src="${escapeHtml(cardPhotoSrc(r))}" alt="${escapeHtml(r.title)}" loading="lazy" onerror="this.outerHTML='<span>${ms.emoji}</span>'">` : `<span>${ms.emoji}</span>`}${r.image && r.image.url && !r.userPhoto ? `<div class="card-credit">Photo: ${escapeHtml(r.image.photographer || 'Unknown')} on Unsplash</div>` : ''}</div>
        <div class="card-body">
          <div class="card-title">${escapeHtml(r.title)}</div>
          <div class="card-desc">${escapeHtml(r.description || '')}</div>
          <div class="card-meta">
            <span>${ms.label}${r.prepTime ? ' • ⏱ ' + escapeHtml(r.prepTime) : ''}</span>
            ${cardCookHtml(r)}
            <span>${r.addedBy ? 'by ' + escapeHtml(r.addedBy) : ''}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}
// ---- Collections (task 10) ----
let currentCollection = 'all';

function collectionNames() {
  return [...new Set(recipes.flatMap((r) => r.collections || []))].sort((a, b) => a.localeCompare(b));
}
// ---- paste-text import and Android share target (task 13) ----
let pendingShare = null;
try { pendingShare = RCUtils.parseShareTarget(location.search); } catch (e) { pendingShare = null; }

function openPasteImport() {
  const overlay = document.getElementById('paste-overlay');
  if (!overlay) return;
  overlay.classList.add('on');
  overlayOpened('paste-overlay');
  updatePasteCount();
  setTimeout(() => { const ta = document.getElementById('paste-text'); if (ta) ta.focus(); }, 50);
}
function closePasteImport() {
  document.getElementById('paste-overlay').classList.remove('on');
  overlayClosed('paste-overlay');
}
function updatePasteCount() {
  const ta = document.getElementById('paste-text');
  const count = document.getElementById('paste-count');
  if (ta && count) count.textContent = `${ta.value.length} / 12000`;
}
async function savePastedRecipe(force) {
  const ta = document.getElementById('paste-text');
  const text = ta ? ta.value.trim() : '';
  if (text.length < 30) { toast('Paste a bit more text than that'); return; }
  const nameInput = document.getElementById('paste-name');
  const name = (nameInput && nameInput.value.trim()) || 'Anonymous';
  setUser(name);
  const btn = document.getElementById('paste-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Reading...'; }
  try {
    const res = await apiFetch(`${API}/import-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: text, addedBy: name, skipDuplicateCheck: force === true }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      toastWithUndo(data.error || 'Already in your chest', 'Save a copy', () => savePastedRecipe(true));
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Could not import that text');
    recipes.push(data);
    renderGrid();
    closePasteImport();
    if (ta) ta.value = '';
    updatePasteCount();
    toast('Saved: ' + data.title);
  } catch (e) {
    toast(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save to chest'; }
  }
}
// What Android handed us through the share target. Applied once the user is
// unlocked, then wiped from the address bar.
function applyPendingShare() {
  if (!pendingShare) return;
  const shared = pendingShare;
  pendingShare = null;
  if (!shared.url && !shared.text) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  if (shared.url) {
    openImport();
    const input = document.getElementById('import-url-input')
      || document.querySelector('#import-overlay input[type="url"], #import-overlay input[type="text"]');
    if (input) { input.value = shared.url; input.focus(); }
    return;
  }
  if (shared.text && shared.text.length >= 80) {
    openPasteImport();
    const ta = document.getElementById('paste-text');
    if (ta) { ta.value = shared.text; updatePasteCount(); ta.focus(); }
  }
}

// ---- Cooking log (task 11) ----
let cookedRecipeId = null;

function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function shortDate(ymd) {
  const d = new Date(ymd + 'T00:00:00');
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function starsText(rating) {
  if (!rating) return '';
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}
function cookedSummary(r) {
  const s = RCUtils.cookStats(r.cookLog);
  if (!s.count) return '';
  const bits = [`Cooked ${s.count} time${s.count === 1 ? '' : 's'}`];
  if (s.lastDate) bits.push(`last on ${shortDate(s.lastDate)}`);
  if (s.avgRating != null) bits.push(`average ${s.avgRating} stars`);
  return bits.join(', ');
}
function cookedSectionHtml(r) {
  const stats = RCUtils.cookStats(r.cookLog);
  const entries = (r.cookLog || []).slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const rows = entries.map((e) => `<li class="cooked-row">
      <span class="cooked-date">${escapeHtml(shortDate(e.date))}</span>
      <span class="cooked-stars" aria-label="${e.rating ? e.rating + ' stars' : 'no rating'}">${escapeHtml(starsText(e.rating))}</span>
      <span class="cooked-note">${escapeHtml(e.note || '')}${e.by ? ` <span class="cooked-by">· ${escapeHtml(e.by)}</span>` : ''}</span>
      <button class="cooked-del" data-entry="${escapeHtml(e.id)}" data-recipe="${r.id}" onclick="deleteCookedEntry(this.dataset.recipe, this.dataset.entry)" aria-label="Delete this entry">✕</button>
    </li>`).join('');

  return `<div class="cooked-section">
      <h2 class="cook-section-h">Cooking log</h2>
      <button class="action-btn primary" data-recipe="${r.id}" onclick="openCookedModal(this.dataset.recipe)">🍳 I cooked this</button>
      ${stats.count ? `<p class="cooked-summary">${escapeHtml(cookedSummary(r))}</p>` : '<p class="cooked-summary">Not cooked yet.</p>'}
      ${rows ? `<ul class="cooked-list">${rows}</ul>` : ''}
    </div>`;
}
function cardCookHtml(r) {
  const s = RCUtils.cookStats(r.cookLog);
  if (!s.count) return '';
  const star = s.avgRating != null ? `<span class="card-cook">★ ${s.avgRating}</span>` : '';
  return `<span class="card-cook">Cooked ${s.count}×</span>${star}`;
}

function openCookedModal(id) {
  cookedRecipeId = id;
  const overlay = document.getElementById('cooked-overlay');
  if (!overlay) return;
  const dateInput = document.getElementById('cooked-date');
  if (dateInput) dateInput.value = localToday();
  const note = document.getElementById('cooked-note');
  if (note) note.value = '';
  document.querySelectorAll('input[name="cooked-rating"]').forEach((el) => { el.checked = false; });
  overlay.classList.add('on');
  overlayOpened('cooked-overlay');
}
function closeCookedModal() {
  const overlay = document.getElementById('cooked-overlay');
  if (overlay) overlay.classList.remove('on');
  overlayClosed('cooked-overlay');
}
function pickedRating() {
  const el = document.querySelector('input[name="cooked-rating"]:checked');
  return el ? Number(el.value) : null;
}
async function saveCookedEntry() {
  if (!cookedRecipeId) return;
  const dateEl = document.getElementById('cooked-date');
  const noteEl = document.getElementById('cooked-note');
  const body = { id: cookedRecipeId };
  if (dateEl && dateEl.value) body.date = dateEl.value;
  const rating = pickedRating();
  if (rating != null) body.rating = rating;
  if (noteEl && noteEl.value.trim()) body.note = noteEl.value.trim();
  const me = (document.getElementById('user-tag') || {}).textContent || '';
  const name = String(me).replace(/^👤\s*/, '').trim();
  if (name && name.toLowerCase() !== 'anonymous') body.by = name;

  try {
    const res = await apiFetch(`${API}/cooked`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save');
    applyCookedRecipe(data);
    closeCookedModal();
    toast('Added to the cooking log');
  } catch (e) {
    toast('Could not save: ' + e.message);
  }
}
async function deleteCookedEntry(recipeId, entryId) {
  if (!confirm('Delete this cooking log entry?')) return;
  try {
    const res = await apiFetch(`${API}/cooked?id=${encodeURIComponent(recipeId)}&entry=${encodeURIComponent(entryId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete');
    applyCookedRecipe(data);
    toast('Entry deleted');
  } catch (e) {
    toast('Could not delete: ' + e.message);
  }
}
function applyCookedRecipe(recipe) {
  if (!recipe || !recipe.id) return;
  const idx = recipes.findIndex((x) => x.id === recipe.id);
  if (idx !== -1) recipes[idx] = recipe;
  renderGrid();
  if (document.getElementById('detail-overlay').classList.contains('on')) openDetail(recipe.id);
}

function setCollectionFilter(name) { currentCollection = name; renderGrid(); }

function collectionsRowHtml(r) {
  const chips = (r.collections || []).map((c) => `<span class="tag-chip coll-chip">${escapeHtml(c)}<button class="tag-x" data-coll="${escapeHtml(c)}" onclick="removeCollectionFromRecipe(this.dataset.recipe, this.dataset.coll)" data-recipe="${r.id}" aria-label="Remove from ${escapeHtml(c)}">✕</button></span>`).join('');
  return `<div class="recipe-tags coll-detail-row">
        <span class="coll-label">Collections:</span>${chips}
        <button class="tag-add-btn" data-recipe="${r.id}" onclick="showCollectionInput(this.dataset.recipe)">+ Add to collection</button>
        <span id="coll-input-wrap"></span>
      </div>`;
}

async function patchCollections(id, list) {
  try {
    const res = await apiFetch(`${API}/recipes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, collections: list }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save');
    const idx = recipes.findIndex((x) => x.id === id);
    if (idx !== -1) recipes[idx] = data;
    renderGrid();
    if (document.getElementById('detail-overlay').classList.contains('on')) openDetail(id);
  } catch (e) {
    toast('Could not save: ' + e.message);
  }
}

function showCollectionInput(id) {
  const wrap = document.getElementById('coll-input-wrap');
  if (!wrap) return;
  const options = collectionNames().map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  wrap.innerHTML = `<input type="text" class="coll-input" id="coll-input" list="coll-names" maxlength="40" placeholder="Collection name">` +
    `<datalist id="coll-names">${options}</datalist>` +
    `<button class="tag-add-btn" onclick="saveCollectionFromInput(this.dataset.recipe)" data-recipe="${id}">Save</button>`;
  const input = document.getElementById('coll-input');
  if (!input) return;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCollectionFromInput(id); } });
  input.focus();
}

async function saveCollectionFromInput(id) {
  const input = document.getElementById('coll-input');
  const name = input ? input.value.trim().slice(0, 40) : '';
  if (!name) return;
  const r = recipes.find((x) => x.id === id);
  const list = (r && r.collections) || [];
  if (list.some((c) => c.toLowerCase() === name.toLowerCase())) { toast('Already in that collection'); return; }
  await patchCollections(id, [...list, name]);
  toast('Added to ' + name);
}

async function removeCollectionFromRecipe(id, name) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  await patchCollections(id, (r.collections || []).filter((c) => c !== name));
  toast('Removed from ' + name);
}

async function refreshRecipesFromServer() {
  try {
    const res = await apiFetch(`${API}/recipes`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;
    // mutate in place so every existing reference stays valid
    recipes.length = 0;
    list.forEach((r) => recipes.push(r));
    renderGrid();
  } catch (e) { /* the grid keeps what it had */ }
}

function openCollectionsManager() {
  const overlay = document.getElementById('coll-overlay');
  if (!overlay) return;
  overlay.classList.add('on');
  overlayOpened('coll-overlay');
  renderCollectionsManager();
}
function closeCollectionsManager() {
  const overlay = document.getElementById('coll-overlay');
  if (overlay) overlay.classList.remove('on');
  overlayClosed('coll-overlay');
}
function renderCollectionsManager() {
  const body = document.getElementById('coll-manager-body');
  if (!body) return;
  const names = collectionNames();
  body.innerHTML = names.length
    ? names.map((n) => `<div class="coll-manage-row"><span class="coll-manage-name">${escapeHtml(n)}</span>` +
        `<button class="btn-secondary" data-coll="${escapeHtml(n)}" onclick="renameCollectionPrompt(this.dataset.coll)">Rename</button>` +
        `<button class="btn-secondary" data-coll="${escapeHtml(n)}" onclick="deleteCollection(this.dataset.coll)">Delete</button></div>`).join('')
    : '<p class="coll-empty">No collections yet. Open a recipe and add one.</p>';
}

async function collectionsAction(payload) {
  const res = await apiFetch(`${API}/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not update collections');
  return data;
}

async function renameCollectionPrompt(from) {
  const to = prompt(`Rename "${from}" to:`, from);
  if (!to) return;
  const name = to.trim().slice(0, 40);
  if (!name || name.toLowerCase() === from.toLowerCase()) return;
  try {
    const data = await collectionsAction({ rename: { from, to: name } });
    if (currentCollection === from) currentCollection = name;
    await refreshRecipesFromServer();
    renderCollectionsManager();
    toast(`Renamed in ${data.changed} recipe${data.changed === 1 ? '' : 's'}`);
  } catch (e) {
    toast('Could not rename: ' + e.message);
  }
}

async function deleteCollection(name) {
  if (!confirm(`Remove the collection "${name}" from every recipe?`)) return;
  try {
    const data = await collectionsAction({ delete: name });
    if (currentCollection === name) currentCollection = 'all';
    await refreshRecipesFromServer();
    renderCollectionsManager();
    toast(`Removed from ${data.changed} recipe${data.changed === 1 ? '' : 's'}`);
  } catch (e) {
    toast('Could not delete: ' + e.message);
  }
}

function setFilter(t) { currentFilter = t; renderGrid(); }
function setMealFilter(m) { currentMealFilter = currentMealFilter === m ? 'all' : m; renderGrid(); }
function setSort(s) { currentSort = s; renderGrid(); }
function toggleShowAllTags() { showAllTags = !showAllTags; renderGrid(); }
async function toggleFavorite(id) {
  const r = recipes.find(x => x.id === id);
  if (!r) return;
  const want = !(r.favorite === true);
  try {
    const res = await apiFetch(`${API}/recipes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, favorite: want }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save');
    const idx = recipes.findIndex(x => x.id === id);
    if (idx !== -1) recipes[idx] = data;
    renderGrid();
    if (document.getElementById('detail-overlay').classList.contains('on')) openDetail(id);
    toast(data.favorite ? 'Added to favorites' : 'Removed from favorites');
  } catch (e) {
    toast('Could not save: ' + e.message);
  }
}

function openDetail(id) {
  const r = recipes.find(x => x.id === id);
  if (!r) return;
  const ms = mealStyle(r.mealType);
  const sourceHref = safeHref(r.sourceUrl);
  let sourceHost = '';
  try { sourceHost = new URL(sourceHref).hostname.replace(/^www\./, ''); } catch {}
    const tagsHtml = (r.tags || []).map(t => `
    <span class="tag">
      ${escapeHtml(t)}
      <button class="tag-x" data-id="${escapeHtml(r.id)}" data-tag="${escapeHtml(t)}" onclick="event.stopPropagation(); removeTag(this.dataset.id, this.dataset.tag)" title="Remove tag" aria-label="Remove tag ${escapeHtml(t)}">✕</button>
    </span>
  `).join('');
  let servingsHtml = '';
  if (r.servings) {
    const baseServings = parseFloat(r.servings);
    if (isFinite(baseServings) && baseServings > 0) {
      const scaleFactor = (currentScaling && currentScaling.recipeId === r.id) ? currentScaling.factor : 1;
      const options = [0.5, 1, 1.5, 2, 3].map(mult => {
        const s = Math.round(baseServings * mult * 10) / 10;
        const selected = Math.abs(mult - scaleFactor) < 0.01 ? ' selected' : '';
        return `<option value="${mult}"${selected}>${s} servings</option>`;
      }).join('');
      servingsHtml = `<select class="servings-select" onchange="changeServings('${r.id}', this.value)">${options}</select>`;
    }
  }
  const scaleFactor = (currentScaling && currentScaling.recipeId === r.id) ? currentScaling.factor : 1;
  const ingredientsHtml = (r.ingredients || []).map(ing => `<li>${scaleIngredientLine(ing, scaleFactor)}</li>`).join('');
  const html = `
    <div class="recipe-hero" style="background:${ms.bg}">${heroPhotoHtml(r, ms)}</div>    <div class="recipe-content">
      <h1 class="recipe-title">${escapeHtml(r.title)}</h1>
      ${r.description ? `<p class="recipe-desc">${escapeHtml(r.description)}</p>` : ''}
      <div class="recipe-meta">
        <span class="meta-pill">${ms.emoji} ${ms.label}</span>
        ${r.prepTime ? `<span class="meta-pill"><span class="k">Prep:</span> ${escapeHtml(r.prepTime)}</span>` : ''}
        ${r.cookTime ? `<span class="meta-pill"><span class="k">Cook:</span> ${escapeHtml(r.cookTime)}</span>` : ''}
        ${r.servings ? `<span class="meta-pill"><span class="k">Serves:</span> ${escapeHtml(r.servings)}</span>${servingsHtml}` : ''}
        ${sourceHref ? `<span class="meta-pill">🔗 <a href="${escapeHtml(sourceHref)}" target="_blank" rel="noopener">${escapeHtml(sourceHost || 'source')}</a></span>` : (r.sourceUrl ? `<span class="meta-pill">🔗 ${escapeHtml(sourceHost || 'source')}</span>` : '')}
      </div>
      <div class="recipe-tags" id="tag-row">
        ${tagsHtml}
        <button class="tag-add-btn" id="tag-add-btn" onclick="showTagInput('${r.id}')">+ Add tag</button>
      </div>
      ${collectionsRowHtml(r)}
      ${cookedSectionHtml(r)}
      <div class="recipe-actions">
        <button class="action-btn primary" onclick="openCookMode('${r.id}')">👨‍🍳 Cook mode</button>
        <button class="action-btn ${r.favorite === true ? 'primary' : ''}" onclick="toggleFavorite('${r.id}')" aria-pressed="${r.favorite === true ? 'true' : 'false'}">${r.favorite === true ? '♥ Favorited' : '♡ Favorite'}</button>
        <button class="action-btn" onclick="addRecipeToShoppingList('${r.id}')">🛒 Add to list</button>
        <button class="action-btn" onclick="openEditMode('${r.id}')">✎ Edit</button>
        <button class="action-btn" onclick="pickRecipePhoto('${r.id}')">📷 ${r.userPhoto ? 'Replace my photo' : 'Add my photo'}</button>
        ${r.userPhoto ? `<button class="action-btn" onclick="removeRecipePhoto('${r.id}')">🗑 Remove my photo</button>` : ''}
        <button class="action-btn" onclick="printRecipe()">🖨️ Print</button>
      </div>
      ${r.ingredients && r.ingredients.length ? `
        <h3 class="section-h">Ingredients</h3>
        <ul class="ing-list">${ingredientsHtml}</ul>
      ` : ''}
      ${r.instructions && r.instructions.length ? `
        <h3 class="section-h">Instructions</h3>
        <ol class="step-list">${r.instructions.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ol>
      ` : ''}
      ${r.notes ? `<div class="notes-box">💡 ${escapeHtml(r.notes)}</div>` : ''}
      <div class="recipe-footer">
        <span>Added by ${escapeHtml(r.addedBy || 'Anonymous')} on ${new Date(r.createdAt).toLocaleDateString()}</span>
        <button class="delete-btn" onclick="deleteRecipe('${r.id}')">Delete</button>
      </div>
    </div>
  `;
  document.getElementById('detail-content').innerHTML = html;
  document.getElementById('detail-overlay').classList.add('on');
  overlayOpened('detail-overlay');
  document.getElementById('detail-modal').scrollTop = 0;
}
function closeDetail() { document.getElementById('detail-overlay').classList.remove('on'); overlayClosed('detail-overlay'); currentScaling = null; }
function printRecipe() { window.print(); }

// ---- User photos of the finished dish ----
let pendingPhotoUpload = null;

function pickRecipePhoto(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*'; // on phones this offers "Take Photo" or the photo library
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    pendingPhotoUpload = { id, file };

    // Small modal instead of a blocking prompt(): credit is optional
    // and Cancel genuinely aborts the upload.
    const r = recipes.find(x => x.id === id);
    const current = (r && r.userPhoto) ? (r.userPhoto.credit || '') : '';
    const field = document.getElementById('credit-input');
    field.value = current;
    document.getElementById('credit-overlay').classList.add('on');
    overlayOpened('credit-overlay');
    field.focus();
  };
  input.click();
}
function cancelPhotoUpload() {
  pendingPhotoUpload = null;
  document.getElementById('credit-overlay').classList.remove('on');
  overlayClosed('credit-overlay');
}
function confirmPhotoUpload() {
  if (!pendingPhotoUpload) { cancelPhotoUpload(); return; }
  const { id, file } = pendingPhotoUpload;
  const credit = document.getElementById('credit-input').value.trim().slice(0, 100);
  pendingPhotoUpload = null;
  document.getElementById('credit-overlay').classList.remove('on');
  overlayClosed('credit-overlay');
  uploadRecipePhoto(id, file, credit);
}
document.getElementById('credit-input').addEventListener('keypress', e => { if (e.key === 'Enter') confirmPhotoUpload(); });
async function uploadRecipePhoto(id, file, credit) {
  if (!file.type.startsWith('image/')) { toast('Please choose an image file'); return; }
  if (file.size > 25 * 1024 * 1024) { toast('That image is too large'); return; }
  toast('Uploading photo...');
  try {
    const { base64 } = await compressImage(file, 1200, 0.85);
    const res = await apiFetch(`${API}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id, imageBase64: base64, credit: credit || '' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    const idx = recipes.findIndex(x => x.id === id);
    if (idx !== -1) recipes[idx] = data;
    openDetail(id);
    renderGrid();
    toast('Photo saved!');
  } catch (e) {
    toast('Could not upload: ' + e.message);
  }
}
async function removeRecipePhoto(id) {
  if (!confirm('Remove your photo from this recipe?')) return;
  try {
    const res = await apiFetch(`${API}/photo?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not remove');
    const idx = recipes.findIndex(x => x.id === id);
    if (idx !== -1) recipes[idx] = data;
    openDetail(id);
    renderGrid();
    toast('Photo removed');
  } catch (e) {
    toast('Could not remove: ' + e.message);
  }
}

function changeServings(recipeId, multStr) {
  const mult = parseFloat(multStr);
  currentScaling = { recipeId, factor: mult };
  openDetail(recipeId);
}

function showTagInput(recipeId) {
  const row = document.getElementById('tag-row');
  const btn = document.getElementById('tag-add-btn');
  if (!row || !btn) return;
  btn.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input';
  input.id = 'tag-input';
  input.placeholder = 'tag name, Enter to save';
  input.maxLength = 30;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = input.value.trim();
      if (val) addTag(recipeId, val);
    } else if (e.key === 'Escape') cancelTagInput();
  });
  input.addEventListener('blur', () => {
    const val = input.value.trim();
    if (val) addTag(recipeId, val);
    else cancelTagInput();
  });
  row.insertBefore(input, btn);
  input.focus();
}
function cancelTagInput() {
  const input = document.getElementById('tag-input');
  const btn = document.getElementById('tag-add-btn');
  if (input) input.remove();
  if (btn) btn.style.display = '';
}
async function addTag(recipeId, tag) {
  const r = recipes.find(x => x.id === recipeId);
  if (!r) return;
  const clean = String(tag).trim().toLowerCase();
  if (!clean) { cancelTagInput(); return; }
  const existing = r.tags || [];
  if (existing.includes(clean)) { toast('Tag already present'); cancelTagInput(); return; }
  await patchRecipe(recipeId, { tags: [...existing, clean] }, 'Tags updated');
}
async function removeTag(recipeId, tag) {
  const r = recipes.find(x => x.id === recipeId);
  if (!r) return;
  await patchRecipe(recipeId, { tags: (r.tags || []).filter(t => t !== tag) }, 'Tag removed');
}
async function patchRecipe(recipeId, fields, successMsg) {
  try {
    const res = await apiFetch(`${API}/recipes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: recipeId, ...fields }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save');
    const idx = recipes.findIndex(x => x.id === recipeId);
    if (idx !== -1) recipes[idx] = data;
    openDetail(recipeId);
    renderGrid();
    if (successMsg) toast(successMsg);
    return data;
  } catch (e) {
    toast('Could not save: ' + e.message);
    cancelTagInput();
    return null;
  }
}

function openEditMode(id) {
  const r = recipes.find(x => x.id === id);
  if (!r) return;
  const mealOptions = ['default','breakfast','lunch','dinner','dessert','snack','drink']
    .map(m => `<option value="${m}"${r.mealType === m ? ' selected' : ''}>${m}</option>`)
    .join('');
  const html = `
    <div class="recipe-content">
      <h1 class="recipe-title" style="font-size:1.4rem">Edit recipe</h1>
      <p class="recipe-desc">Changes save to the shared chest for everyone.</p>
      <div class="edit-field">
        <label class="edit-label">Title</label>
        <input type="text" class="edit-input" id="edit-title" value="${escapeHtml(r.title)}" maxlength="200">
      </div>
      <div class="edit-field">
        <label class="edit-label">Description</label>
        <input type="text" class="edit-input" id="edit-description" value="${escapeHtml(r.description || '')}" maxlength="500">
      </div>
      <div class="edit-row">
        <div class="edit-field">
          <label class="edit-label">Prep time</label>
          <input type="text" class="edit-input" id="edit-prepTime" value="${escapeHtml(r.prepTime || '')}" maxlength="40">
        </div>
        <div class="edit-field">
          <label class="edit-label">Cook time</label>
          <input type="text" class="edit-input" id="edit-cookTime" value="${escapeHtml(r.cookTime || '')}" maxlength="40">
        </div>
        <div class="edit-field">
          <label class="edit-label">Servings</label>
          <input type="text" class="edit-input" id="edit-servings" value="${escapeHtml(r.servings || '')}" maxlength="40">
        </div>
      </div>
      <div class="edit-field">
        <label class="edit-label">Meal type</label>
        <select class="edit-input" id="edit-mealType">${mealOptions}</select>
      </div>
      <div class="edit-field">
        <label class="edit-label">Ingredients (one per line)</label>
        <textarea class="edit-textarea" id="edit-ingredients">${escapeHtml((r.ingredients || []).join('\n'))}</textarea>
      </div>
      <div class="edit-field">
        <label class="edit-label">Instructions (one per line)</label>
        <textarea class="edit-textarea" id="edit-instructions" style="min-height:200px">${escapeHtml((r.instructions || []).join('\n'))}</textarea>
      </div>
      <div class="edit-field">
        <label class="edit-label">Notes</label>
        <textarea class="edit-textarea" id="edit-notes" style="min-height:80px">${escapeHtml(r.notes || '')}</textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;flex-wrap:wrap">
        <button class="btn-secondary" onclick="openDetail('${r.id}')">Cancel</button>
        <button class="btn-primary" onclick="saveEdit('${r.id}')">Save changes</button>
      </div>
    </div>
  `;
  document.getElementById('detail-content').innerHTML = html;
  document.getElementById('detail-modal').scrollTop = 0;
}
async function saveEdit(id) {
  const fields = {
    title: document.getElementById('edit-title').value,
    description: document.getElementById('edit-description').value,
    prepTime: document.getElementById('edit-prepTime').value,
    cookTime: document.getElementById('edit-cookTime').value,
    servings: document.getElementById('edit-servings').value,
    mealType: document.getElementById('edit-mealType').value,
    ingredients: document.getElementById('edit-ingredients').value.split('\n').map(s => s.trim()).filter(Boolean),
    instructions: document.getElementById('edit-instructions').value.split('\n').map(s => s.trim()).filter(Boolean),
    notes: document.getElementById('edit-notes').value,
  };
  if (!fields.title.trim()) { toast('Title cannot be empty'); return; }
  if (fields.mealType === 'default') {
    const r = recipes.find(x => x.id === id);
    const guess = detectMealType(r ? r.tags : []);
    if (guess) fields.mealType = guess;
  }
  const updated = await patchRecipe(id, fields, 'Recipe updated');
  if (updated) openDetail(id);
}

// ---- Cook mode (fullscreen) ----
let wakeLock = null;

// Everything the cook screen remembers lives in localStorage: timers as
// absolute end times (so a locked phone cannot drift them), the ticked
// ingredients and steps per recipe, and the text size.
const COOK_TIMERS_KEY = 'rc_cook_timers';
const COOK_SCALE_KEY = 'rc_cook_scale';
const COOK_STATE_PREFIX = 'rc_cook_state:';
const COOK_SCALE_STEPS = [1, 1.15, 1.3, 1.5, 1.75];
const COOK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let cookRecipeId = null;
let cookTimers = [];
let cookListState = { ing: [], steps: [], ts: 0 };
let cookStepTimers = [];
let cookTickHandle = null;
let cookAudioCtx = null;
const cookBeeps = {};
const cookDoneSeen = new Set();

function readCookStore(key, fallback) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    return raw == null ? fallback : raw;
  } catch (e) {
    return fallback;
  }
}
function writeCookStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
}

// ---- timers: storage ----
function loadCookTimers() {
  const raw = readCookStore(COOK_TIMERS_KEY, []);
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw.filter((t) => t
    && typeof t.id === 'string'
    && isFinite(Number(t.endsAt))
    && RCUtils.isCookStateFresh({ ts: Number(t.startedAt) }, now, COOK_MAX_AGE_MS));
}
function saveCookTimers() {
  writeCookStore(COOK_TIMERS_KEY, cookTimers);
}

// ---- timers: actions ----
function startCookTimerAt(stepIndex, timerIndex) {
  const found = (cookStepTimers[stepIndex] || [])[timerIndex];
  if (!found) return;
  ensureCookAudio();
  const id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  const timer = RCUtils.createTimer({ id, label: found.label, seconds: found.seconds, now: Date.now() });
  timer.recipeId = cookRecipeId;
  timer.step = stepIndex;
  timer.startedAt = Date.now();
  cookTimers.push(timer);
  saveCookTimers();
  renderCookTimers(true);
  toast('Timer started: ' + found.label);
}
function findCookTimer(id) {
  return cookTimers.find((t) => t.id === id);
}
function replaceCookTimer(updated) {
  cookTimers = cookTimers.map((t) => (t.id === updated.id ? updated : t));
  saveCookTimers();
  renderCookTimers(true);
}
function toggleCookTimerPause(id) {
  const t = findCookTimer(id);
  if (!t) return;
  const now = Date.now();
  replaceCookTimer(t.pausedRemainingMs != null ? RCUtils.resumeTimer(t, now) : RCUtils.pauseTimer(t, now));
}
function addCookTimerTime(id, ms) {
  const t = findCookTimer(id);
  if (!t) return;
  cookDoneSeen.delete(t.id);
  stopBeep(t.id);
  replaceCookTimer(RCUtils.addTime(t, ms, Date.now()));
}
function removeCookTimer(id) {
  stopBeep(id);
  cookDoneSeen.delete(id);
  cookTimers = cookTimers.filter((t) => t.id !== id);
  saveCookTimers();
  renderCookTimers(true);
}

// ---- timers: sound ----
// The AudioContext has to be created in a click handler: browsers refuse to
// start one otherwise. Every path is wrapped so a blocked or missing audio API
// can never break the screen.
function ensureCookAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!cookAudioCtx) cookAudioCtx = new Ctx();
    if (cookAudioCtx.state === 'suspended' && cookAudioCtx.resume) cookAudioCtx.resume();
  } catch (e) {
    cookAudioCtx = null;
  }
}
function startBeep(id) {
  stopBeep(id);
  if (!cookAudioCtx) return;
  const play = () => {
    try {
      const osc = cookAudioCtx.createOscillator();
      const gain = cookAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.07;
      osc.connect(gain);
      gain.connect(cookAudioCtx.destination);
      osc.start();
      osc.stop(cookAudioCtx.currentTime + 0.18);
    } catch (e) { /* never throw from a sound */ }
  };
  try {
    play();
    cookBeeps[id] = {
      interval: setInterval(play, 900),
      timeout: setTimeout(() => stopBeep(id), 30000),
    };
  } catch (e) { /* ignore */ }
}
function stopBeep(id) {
  const b = cookBeeps[id];
  if (!b) return;
  clearInterval(b.interval);
  clearTimeout(b.timeout);
  delete cookBeeps[id];
}

function onCookTimerDone(timer) {
  startBeep(timer.id);
  try {
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  } catch (e) { /* ignore */ }
  toast('Timer done: ' + timer.label);
}

// ---- timers: rendering ----
function cookTimerButtons(t) {
  const paused = t.pausedRemainingMs != null;
  return '<button type="button" class="cook-timer-btn" onclick="toggleCookTimerPause(\'' + t.id + '\')">'
    + (paused ? 'Resume' : 'Pause') + '</button>'
    + '<button type="button" class="cook-timer-btn" onclick="addCookTimerTime(\'' + t.id + '\',60000)">+1 min</button>'
    + '<button type="button" class="cook-timer-btn" onclick="removeCookTimer(\'' + t.id + '\')">Remove</button>';
}

function renderCookTimers(force) {
  const bar = document.getElementById('cook-timers');
  if (!bar) return;
  const now = Date.now();
  const mine = cookTimers.filter((t) => t.recipeId === cookRecipeId);
  const sig = mine.map((t) => t.id).join(',');

  if (force || bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    bar.hidden = mine.length === 0;
    bar.innerHTML = mine.length === 0 ? '' : mine.map((t) => (
      '<div class="cook-timer" data-id="' + escapeHtml(t.id) + '" onclick="stopBeep(\'' + t.id + '\')">'
      + '<div class="cook-timer-head">'
      + '<span class="cook-timer-where">Step ' + (Number.isInteger(t.step) ? t.step + 1 : '') + '</span>'
      + '<span class="cook-timer-label">' + escapeHtml(t.label) + '</span>'
      + '</div>'
      + '<div class="cook-timer-time">' + RCUtils.formatDuration(RCUtils.remainingMs(t, now)) + '</div>'
      + '<div class="cook-timer-btns">' + cookTimerButtons(t) + '</div>'
      + '</div>'
    )).join('');
  }

  // Recompute from the absolute end time on every tick, so a phone that was
  // asleep for ten minutes shows the right number the moment it wakes.
  for (const t of mine) {
    const row = bar.querySelector('[data-id="' + t.id + '"]');
    if (!row) continue;
    const remaining = RCUtils.remainingMs(t, now);
    const timeEl = row.querySelector('.cook-timer-time');
    if (timeEl) timeEl.textContent = RCUtils.formatDuration(remaining);
    const paused = t.pausedRemainingMs != null;
    row.classList.toggle('paused', paused);
    row.classList.toggle('done', remaining === 0);
    if (paused !== row.dataset.paused && force !== true) {
      // The Pause/Resume label has to follow the state.
      const btns = row.querySelector('.cook-timer-btns');
      if (btns) btns.innerHTML = cookTimerButtons(t);
    }
    row.dataset.paused = String(paused);
    if (remaining === 0 && !cookDoneSeen.has(t.id)) {
      cookDoneSeen.add(t.id);
      onCookTimerDone(t);
    }
  }
}
function startCookTicker() {
  renderCookTimers(true);
  if (cookTickHandle) return;
  cookTickHandle = setInterval(() => renderCookTimers(false), 250);
}
function stopCookTicker() {
  if (cookTickHandle) {
    clearInterval(cookTickHandle);
    cookTickHandle = null;
  }
  Object.keys(cookBeeps).forEach(stopBeep);
}
function onCookVisibilityChange() {
  if (!document.hidden) renderCookTimers(true);
}

// ---- checklists ----
function loadCookState(recipeId) {
  const raw = readCookStore(COOK_STATE_PREFIX + recipeId, null);
  if (!raw || typeof raw !== 'object') return { ing: [], steps: [], ts: 0 };
  if (!RCUtils.isCookStateFresh(raw, Date.now(), COOK_MAX_AGE_MS)) {
    try { localStorage.removeItem(COOK_STATE_PREFIX + recipeId); } catch (e) { /* ignore */ }
    return { ing: [], steps: [], ts: 0 };
  }
  return {
    ing: Array.isArray(raw.ing) ? raw.ing.filter((n) => Number.isInteger(n)) : [],
    steps: Array.isArray(raw.steps) ? raw.steps.filter((n) => Number.isInteger(n)) : [],
    ts: Number(raw.ts) || 0,
  };
}
function saveCookState() {
  cookListState.ts = Date.now();
  writeCookStore(COOK_STATE_PREFIX + cookRecipeId, cookListState);
}
function updateCookProgress() {
  const el = document.getElementById('cook-progress');
  if (!el) return;
  const total = (document.querySelectorAll('.cook-steps .cook-step').length) || 0;
  const done = cookListState.steps.length;
  el.textContent = done + ' of ' + total + ' steps done';
}
function toggleCookIng(i) {
  const at = cookListState.ing.indexOf(i);
  if (at === -1) cookListState.ing.push(i); else cookListState.ing.splice(at, 1);
  saveCookState();
  const box = document.querySelector('.cook-ing-check[data-i="' + i + '"]');
  if (box && box.closest('.cook-ing-row')) {
    box.closest('.cook-ing-row').classList.toggle('checked', cookListState.ing.includes(i));
  }
}
function toggleCookStep(i) {
  const at = cookListState.steps.indexOf(i);
  if (at === -1) cookListState.steps.push(i); else cookListState.steps.splice(at, 1);
  saveCookState();
  const el = document.querySelector('.cook-step[data-step="' + i + '"]');
  if (el) {
    const done = cookListState.steps.includes(i);
    el.classList.toggle('done', done);
    el.setAttribute('aria-pressed', done ? 'true' : 'false');
  }
  updateCookProgress();
}
function cookStepKey(event, i) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggleCookStep(i);
  }
}
function resetCookList() {
  cookListState = { ing: [], steps: [], ts: Date.now() };
  saveCookState();
  document.querySelectorAll('.cook-ing-check').forEach((box) => {
    box.checked = false;
    if (box.closest('.cook-ing-row')) box.closest('.cook-ing-row').classList.remove('checked');
  });
  document.querySelectorAll('.cook-steps .cook-step').forEach((el) => {
    el.classList.remove('done');
    el.setAttribute('aria-pressed', 'false');
  });
  updateCookProgress();
  toast('Checklist reset');
}

// ---- text size ----
function cookScale() {
  const v = Number(readCookStore(COOK_SCALE_KEY, 1));
  return COOK_SCALE_STEPS.includes(v) ? v : 1;
}
function applyCookScale() {
  const el = document.getElementById('cook-content');
  if (el) el.style.setProperty('--cook-scale', String(cookScale()));
}
function changeCookScale(direction) {
  const i = COOK_SCALE_STEPS.indexOf(cookScale());
  const next = COOK_SCALE_STEPS[Math.max(0, Math.min(COOK_SCALE_STEPS.length - 1, i + direction))];
  writeCookStore(COOK_SCALE_KEY, next);
  applyCookScale();
}

async function openCookMode(id) {
  const r = recipes.find(x => x.id === id);
  if (!r) { toast('Recipe not found'); return; }

  const ms = mealStyle(r.mealType);
  const scaleFactor = (currentScaling && currentScaling.recipeId === r.id) ? currentScaling.factor : 1;

  cookRecipeId = r.id;
  cookListState = loadCookState(r.id);
  cookTimers = loadCookTimers();
  cookDoneSeen.clear();
  for (const t of cookTimers) {
    if (t.recipeId === r.id && RCUtils.isDone(t, Date.now())) cookDoneSeen.add(t.id);
  }

  // Detected durations are kept in an array and referenced by index, so no
  // recipe text ever has to be quoted inside an onclick attribute.
  cookStepTimers = (r.instructions || []).map((s) => RCUtils.parseTimersFromStep(s));

  const ingredientsHtml = (r.ingredients || []).map((ing, i) => {
    const checked = cookListState.ing.includes(i) ? ' checked' : '';
    return '<li><label class="cook-ing-row' + (checked ? ' checked' : '') + '">'
      + '<input type="checkbox" class="cook-ing-check" data-i="' + i + '"' + checked + ' onchange="toggleCookIng(' + i + ')">'
      + '<span class="cook-ing-text">' + scaleIngredientLine(ing, scaleFactor) + '</span>'
      + '</label></li>';
  }).join('');

  const stepsHtml = (r.instructions || []).map((s, i) => {
    const done = cookListState.steps.includes(i);
    const chips = (cookStepTimers[i] || []).map((t, j) => (
      '<button type="button" class="cook-timer-chip" onclick="startCookTimerAt(' + i + ',' + j + ')">'
      + '⏱ Start ' + escapeHtml(t.label) + '</button>'
    )).join('');
    return '<li class="cook-step-item"><div class="cook-step-body">'
      + '<div class="cook-step' + (done ? ' done' : '') + '" data-step="' + i + '" role="button" tabindex="0"'
      + ' aria-pressed="' + (done ? 'true' : 'false') + '" onclick="toggleCookStep(' + i + ')"'
      + ' onkeydown="cookStepKey(event,' + i + ')">' + escapeHtml(s) + '</div>'
      + (chips ? '<div class="cook-step-timers">' + chips + '</div>' : '')
      + '</div></li>';
  }).join('');

  const metaBits = [];
  if (r.prepTime) metaBits.push(`<span class="meta-pill"><span class="k">Prep:</span> ${escapeHtml(r.prepTime)}</span>`);
  if (r.cookTime) metaBits.push(`<span class="meta-pill"><span class="k">Cook:</span> ${escapeHtml(r.cookTime)}</span>`);
  if (r.servings) metaBits.push(`<span class="meta-pill"><span class="k">Serves:</span> ${escapeHtml(r.servings)}</span>`);

  const totalSteps = (r.instructions || []).length;

  const html = `
    <button class="cook-close" onclick="closeCookMode()" title="Close" aria-label="Close cook mode">✕</button>
    <div class="cook-scale-bar">
      <span class="cook-scale-label">Text</span>
      <button type="button" class="cook-scale-btn" onclick="changeCookScale(-1)" aria-label="Smaller text">A−</button>
      <button type="button" class="cook-scale-btn" onclick="changeCookScale(1)" aria-label="Larger text">A+</button>
    </div>
    <div class="cook-timers" id="cook-timers" hidden></div>
    <div class="cook-hero" style="background:${ms.bg}">${heroPhotoHtml(r, ms)}</div>
    <h1 class="cook-title">${escapeHtml(r.title)}</h1>
    ${r.description ? `<p class="recipe-desc" style="font-size:1.05rem">${escapeHtml(r.description)}</p>` : ''}
    <div class="cook-meta">
      <span class="meta-pill">${ms.emoji} ${ms.label}</span>
      ${metaBits.join('')}
    </div>
    ${r.ingredients && r.ingredients.length ? `
      <h2 class="cook-section-h">Ingredients</h2>
      <ul class="cook-ing">${ingredientsHtml}</ul>
    ` : ''}
    ${totalSteps ? `
      <div class="cook-steps-head">
        <h2 class="cook-section-h">Instructions</h2>
        <div class="cook-steps-tools">
          <span class="cook-progress" id="cook-progress">0 of ${totalSteps} steps done</span>
          <button type="button" class="cook-reset" onclick="resetCookList()">Reset</button>
        </div>
      </div>
      <ol class="cook-steps">${stepsHtml}</ol>
    ` : ''}
    ${r.notes ? `<div class="cook-notes">💡 ${escapeHtml(r.notes)}</div>` : ''}
    <div class="cook-footer">
      <button onclick="closeCookMode()">Done cooking</button>
    </div>
  `;
  document.getElementById('cook-content').innerHTML = html;
  document.getElementById('cook-overlay').classList.add('on');
  overlayOpened('cook-overlay');
  document.getElementById('cook-content').scrollTop = 0;

  applyCookScale();
  updateCookProgress();
  startCookTicker();
  document.addEventListener('visibilitychange', onCookVisibilityChange);

  const overlay = document.getElementById('cook-overlay');
  try {
    if (overlay.requestFullscreen) await overlay.requestFullscreen();
    else if (overlay.webkitRequestFullscreen) overlay.webkitRequestFullscreen();
  } catch (e) {
    // Fullscreen was denied or not supported — the overlay still fills the viewport
  }

  requestWakeLock();
}

function closeCookMode() {
  const now = Date.now();
  const running = cookTimers.filter((t) => t.recipeId === cookRecipeId && !RCUtils.isDone(t, now));
  if (running.length && !confirm('Timers are still running. Leave anyway?')) return;

  stopCookTicker();
  document.removeEventListener('visibilitychange', onCookVisibilityChange);
  document.getElementById('cook-overlay').classList.remove('on');
  overlayClosed('cook-overlay');
  releaseWakeLock();
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (document.webkitFullscreenElement) {
    document.webkitExitFullscreen();
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    // Some browsers require the page to be visible and may reject silently
  }
}
function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.getElementById('cook-overlay').classList.contains('on')) {
    requestWakeLock();
  }
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.getElementById('cook-overlay').classList.contains('on')) {
    closeCookMode();
  }
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement && document.getElementById('cook-overlay').classList.contains('on')) {
    closeCookMode();
  }
});

// ---- Shopping list ----
async function openShoppingList() {
  document.getElementById('shopping-overlay').classList.add('on');
  overlayOpened('shopping-overlay');
  await loadShoppingList();
  renderShoppingList();
  if (sharedMode()) startListPolling();
}
function closeShoppingList() { stopListPolling(); document.getElementById('shopping-overlay').classList.remove('on'); overlayClosed('shopping-overlay'); }
// ---- Load state: a failed load is not an empty list ----
// What a load actually told us. Only a 2xx says what the server holds; any
// other outcome means "unknown", and writing after it would replace the real
// list with whatever this device happens to be holding.
function loadOutcome(ok, body) {
  if (!ok) return { status: 'failed', data: null };
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return { status: 'ok', data };
}
// Every write (add / tick / remove / clear / add recipe / add week) is gated on
// this: it is only safe once a load has succeeded.
function listWriteBlocked(loadState) {
  return loadState !== 'ok';
}
// A delete can only be undone when the server says it kept a copy.
function undoOffer(ok, body) {
  const data = body && typeof body === 'object' ? body : {};
  if (!ok || data.undoable !== true) return { offer: false, seconds: 0 };
  const seconds = Number(data.undoWindowSeconds);
  return { offer: true, seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0 };
}

async function loadShoppingList() {
  let ok;
  let data = null;
  try {
    const res = await apiFetch(`${API}/shopping-list?deviceId=${encodeURIComponent(listDeviceId())}`, { credentials: 'same-origin' });
    ok = res.ok;
    if (ok) data = await res.json();
  } catch (e) {
    ok = false;
  }
  const out = loadOutcome(ok, data);
  if (out.status === 'ok') {
    shoppingListState = 'ok';
    shoppingList = { items: [], ...out.data };
    if (!Array.isArray(shoppingList.items)) shoppingList.items = [];
  } else {
    // Keep whatever we already hold on screen: it may be the only copy left,
    // and it is still not allowed to be written back over the server's list.
    shoppingListState = 'failed';
  }
  return shoppingListState;
}
async function retryShoppingList() {
  await loadShoppingList();
  renderShoppingList();
}
// ---- Shared household list, aisles and merging (task 8) ----
const SHARED_MODE_KEY = 'rc_shared_mode';
const SL_GROUP_KEY = 'rc_sl_group';
const AISLE_ORDER = ['Produce', 'Meat & seafood', 'Dairy & eggs', 'Bakery', 'Frozen', 'Pantry', 'Spices & baking', 'Drinks', 'Other'];

// Shared mode is one switch for both the list and the plan: when it is on we
// send the literal device id "shared", so everyone with the access code reads
// and writes the same list instead of their own.
function sharedMode() {
  try { return localStorage.getItem(SHARED_MODE_KEY) === '1'; } catch (e) { return false; }
}
function listDeviceId() { return sharedMode() ? 'shared' : getDeviceId(); }
function setSharedMode(on) {
  try { localStorage.setItem(SHARED_MODE_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
  ['sl-shared', 'mp-shared'].forEach((id) => {
    const box = document.getElementById(id);
    if (box) box.checked = !!on;
  });
  updateSharedNotes();
  if (on) startListPolling();
  else stopListPolling();
  toast(on ? 'Sharing with everyone' : 'Back to your own list');
}
function updateSharedNotes() {
  const on = sharedMode();
  const slNote = document.getElementById('sl-note');
  const mpNote = document.getElementById('mp-note');
  if (slNote) slNote.textContent = on ? 'Shared with everyone using the access code. Updates every 20 seconds.' : 'Saved for this device.';
  if (mpNote) mpNote.textContent = on ? 'Shared with everyone using the access code.' : 'Saved for this device. Tap a day to add recipes.';
  const slBox = document.getElementById('sl-shared');
  const mpBox = document.getElementById('mp-shared');
  if (slBox) slBox.checked = on;
  if (mpBox) mpBox.checked = on;
}
function groupByAisleOn() {
  try { const v = localStorage.getItem(SL_GROUP_KEY); return v === null ? true : v === '1'; } catch (e) { return true; }
}
function setGroupByAisle(on) {
  try { localStorage.setItem(SL_GROUP_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
  renderShoppingList();
}

function shoppingRowHtml(entry) {
  const it = entry.it;
  return `
    <div class="sl-item ${it.checked ? 'checked' : ''}">
      <input type="checkbox" ${it.checked ? 'checked' : ''} onchange="toggleShoppingItem(${entry.i})">
      <span class="sl-text">${escapeHtml(it.text)}</span>
      <button class="sl-del" onclick="removeShoppingItem(${entry.i})" title="Remove" aria-label="Remove item">✕</button>
    </div>`;
}

function renderShoppingList() {
  const el = document.getElementById('sl-list');
  const items = shoppingList.items || [];
  const blocked = listWriteBlocked(shoppingListState);
  const groupBox = document.getElementById('sl-group');
  const groupOn = groupByAisleOn();
  if (groupBox) groupBox.checked = groupOn;
  updateSharedNotes();

  const banner = blocked
    ? `<div class="sl-error" role="alert">
        <span>Your list didn't load, so it can't be changed right now. Nothing on the server has been overwritten.</span>
        <button class="btn-secondary" onclick="retryShoppingList()">Retry</button>
      </div>`
    : '';
  if (!items.length) {
    el.innerHTML = banner + '<div class="sl-empty">No items yet. Add one above or open a recipe and tap "Add to list".</div>';
    return;
  }

  const entries = items.map((it, i) => ({ it: it, i: i }));
  if (!groupOn) {
    el.innerHTML = banner + entries.map(shoppingRowHtml).join('');
    return;
  }

  // Grouped view: a fixed walking order, and ticked items sink within their group.
  const byAisle = {};
  entries.forEach((e) => {
    const aisle = RCUtils.classifyAisle(e.it.text);
    if (!byAisle[aisle]) byAisle[aisle] = [];
    byAisle[aisle].push(e);
  });
  let html = '';
  AISLE_ORDER.forEach((aisle) => {
    const group = byAisle[aisle];
    if (!group || !group.length) return;
    group.sort((a, b) => (a.it.checked ? 1 : 0) - (b.it.checked ? 1 : 0) || a.i - b.i);
    html += `<div class="sl-aisle"><h3 class="sl-aisle-h">${escapeHtml(aisle)}</h3>${group.map(shoppingRowHtml).join('')}</div>`;
  });
  el.innerHTML = banner + html;
}

// Blocks a shopping-list write while the load is failed, with a message that
// says what to do, instead of saving an empty-looking list over the real one.
function shoppingListReady() {
  if (!listWriteBlocked(shoppingListState)) return true;
  toast('Your list didn\'t load — open Shopping List and tap Retry first.');
  return false;
}

// The last change, as something that can be replayed onto a newer list.
let lastListOp = null;

async function saveShoppingList(op, retried) {
  if (!shoppingListReady()) return;
  if (typeof op === 'function') lastListOp = op;
  try {
    const body = { deviceId: listDeviceId(), items: shoppingList.items };
    if (shoppingList.updatedAt != null) body.baseUpdatedAt = shoppingList.updatedAt;
    const res = await apiFetch(`${API}/shopping-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (!retried && data && data.current) {
        // Someone else got there first. Take their list, re-apply our change on
        // top of it, and try once more.
        shoppingList = { items: [], ...data.current };
        if (!Array.isArray(shoppingList.items)) shoppingList.items = [];
        toast('List updated by someone else');
        if (lastListOp) lastListOp(shoppingList.items);
        return saveShoppingList(lastListOp, true);
      }
      toast('The list kept changing — pull to refresh and try again.');
      await loadShoppingList();
      renderShoppingList();
      return;
    }

    if (!res.ok) throw new Error('Save failed');
    shoppingList = await res.json();
    renderShoppingList();
  } catch (e) {
    toast('Could not save list: ' + e.message);
  }
}

function addShoppingItem() {
  const input = document.getElementById('sl-input');
  const text = input.value.trim();
  if (!text) return;
  if (!shoppingListReady()) return;
  shoppingList.items.push({ text, checked: false });
  input.value = '';
  saveShoppingList((items) => { items.push({ text: text, checked: false }); });
}

function toggleShoppingItem(i) {
  const item = shoppingList.items[i];
  if (!item) return;
  if (!shoppingListReady()) return;
  const next = !item.checked;
  const text = item.text;
  item.checked = next;
  saveShoppingList((items) => {
    const match = items.find((x) => x.text === text);
    if (match) match.checked = next;
  });
}

function removeShoppingItem(i) {
  const item = shoppingList.items[i];
  if (!item) return;
  if (!shoppingListReady()) return;
  const text = item.text;
  shoppingList.items.splice(i, 1);
  saveShoppingList((items) => {
    const at = items.findIndex((x) => x.text === text);
    if (at >= 0) items.splice(at, 1);
  });
}

function mergeShoppingList() {
  if (!shoppingListReady()) return;
  const before = shoppingList.items.length;
  const merged = RCUtils.mergeShoppingItems(shoppingList.items);
  if (merged.length === before) { toast('Nothing to merge'); return; }
  shoppingList.items = merged;
  renderShoppingList();
  saveShoppingList((items) => {
    const m = RCUtils.mergeShoppingItems(items);
    items.length = 0;
    m.forEach((x) => items.push(x));
  });
  const saved = before - merged.length;
  toast(`Merged ${saved} duplicate${saved === 1 ? '' : 's'}`);
}

// While the list is open in shared mode it refreshes itself, so two phones
// converge without anyone pressing anything.
let listPollTimer = null;
function startListPolling() {
  stopListPolling();
  if (!sharedMode()) return;
  listPollTimer = setInterval(async () => {
    if (document.hidden || !sharedMode()) return;
    const overlay = document.getElementById('shopping-overlay');
    if (!overlay || !overlay.classList.contains('on')) { stopListPolling(); return; }
    await loadShoppingList();
    renderShoppingList();
  }, 20000);
}
function stopListPolling() {
  if (listPollTimer) { clearInterval(listPollTimer); listPollTimer = null; }
}

async function clearShoppingList() {
  if (!confirm('Clear the entire shopping list?')) return;
  if (!shoppingListReady()) return;
  try {
    const res = await apiFetch(`${API}/shopping-list?deviceId=${encodeURIComponent(listDeviceId())}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    shoppingList = { items: [] };
    renderShoppingList();
  } catch (e) {
    // Keep the local list as-is: showing an empty list while the server
    // still has the items would silently lose the user's sync.
    toast('Could not clear: ' + e.message);
  }
}
async function addRecipeToShoppingList(id) {
  const r = recipes.find(x => x.id === id);
  if (!r || !r.ingredients) return;
  await loadShoppingList();
  if (!shoppingListReady()) return;

  const additions = r.ingredients.map((ing) => ({ text: String(ing), checked: false, recipeId: id }));
  const nameOf = (text) => RCUtils.normalizeIngredientName(RCUtils.parseIngredientLine(text).name);
  const priorNames = new Set((shoppingList.items || []).map((it) => nameOf(it.text)));
  let mergedCount = 0;
  additions.forEach((a) => { if (priorNames.has(nameOf(a.text))) mergedCount++; });
  const addedCount = additions.length - mergedCount;

  // Merging the whole list (not just the additions) is what turns "2 cups
  // flour" already on the list plus "1 cup flour" from the recipe into three.
  const apply = (items) => {
    const combined = RCUtils.mergeShoppingItems(items.concat(additions.map((a) => ({ ...a }))));
    items.length = 0;
    combined.forEach((x) => items.push(x));
  };
  apply(shoppingList.items);
  await saveShoppingList(apply);
  renderShoppingList();
  toast(`${addedCount} added, ${mergedCount} merged`);
}


// ---- What can I make? (pantry matcher) ----
const PANTRY_KEY = 'rc_pantry';
const PANTRY_BASICS_KEY = 'rc_pantry_basics';
let pantryResults = [];

function getPantry() {
  try {
    const raw = JSON.parse(localStorage.getItem(PANTRY_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, 100) : [];
  } catch (e) { return []; }
}
function savePantry(list) {
  try { localStorage.setItem(PANTRY_KEY, JSON.stringify(list.slice(0, 100))); } catch (e) { /* ignore */ }
}
function pantryBasicsOn() {
  try { const v = localStorage.getItem(PANTRY_BASICS_KEY); return v === null ? true : v === '1'; } catch (e) { return true; }
}

function openPantry() {
  document.getElementById('pantry-overlay').classList.add('on');
  overlayOpened('pantry-overlay');
  const box = document.getElementById('pantry-basics');
  if (box) box.checked = pantryBasicsOn();
  fillPantrySuggestions();
  renderPantry();
  const input = document.getElementById('pantry-input');
  if (input) input.focus();
}
function closePantry() {
  document.getElementById('pantry-overlay').classList.remove('on');
  overlayClosed('pantry-overlay');
}

function addPantryItem() {
  const input = document.getElementById('pantry-input');
  if (!input) return;
  const parts = String(input.value || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return;
  const list = getPantry();
  parts.forEach((p) => {
    const clean = p.slice(0, 60);
    if (!list.some((x) => x.toLowerCase() === clean.toLowerCase())) list.push(clean);
  });
  savePantry(list);
  input.value = '';
  renderPantry();
}
function removePantryItem(i) {
  const list = getPantry();
  list.splice(i, 1);
  savePantry(list);
  renderPantry();
}
function clearPantry() {
  savePantry([]);
  renderPantry();
  toast('Pantry cleared');
}
function setPantryBasics(on) {
  try { localStorage.setItem(PANTRY_BASICS_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
  renderPantry();
}

// Suggestions are the ingredient names this collection actually uses, so the
// list is never a generic grocery catalogue.
function fillPantrySuggestions() {
  const el = document.getElementById('pantry-suggestions');
  if (!el) return;
  const seen = new Set();
  const names = [];
  (recipes || []).forEach((r) => {
    (r.ingredients || []).forEach((line) => {
      const parsed = RCUtils.parseIngredientLine(String(line));
      const name = (parsed.name || '').trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return;
      seen.add(key);
      names.push(name);
    });
  });
  names.sort();
  el.innerHTML = names.slice(0, 300).map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

function renderPantry() {
  const chips = document.getElementById('pantry-chips');
  const list = getPantry();
  if (chips) {
    chips.innerHTML = list.map((p, i) =>
      `<span class="pantry-chip">${escapeHtml(p)}<button class="pantry-chip-x" onclick="removePantryItem(${i})" aria-label="Remove ${escapeHtml(p)}">✕</button></span>`
    ).join('');
  }

  const box = document.getElementById('pantry-results');
  if (!box) return;

  pantryResults = RCUtils.matchRecipesToPantry(recipes, list, { assumeBasics: pantryBasicsOn() });
  if (!pantryResults.length) {
    box.innerHTML = `<div class="pantry-empty">${list.length
      ? 'Nothing matches yet. Add a few more things you have.'
      : 'Add what you have to see what you can cook.'}</div>`;
    return;
  }

  box.innerHTML = pantryResults.map((r, i) => {
    const first = r.missing.slice(0, 4);
    const more = r.missing.length - first.length;
    const missingText = r.missing.length
      ? 'Missing: ' + first.join(', ') + (more > 0 ? ` +${more} more` : '')
      : 'You have everything';
    return `<div class="pantry-card">
      <button class="pantry-card-main" onclick="openPantryResult('${escapeHtml(r.recipe.id)}')">
        <span class="pantry-card-title">${escapeHtml(r.recipe.title)}</span>
        <span class="pantry-card-score">Have ${r.have} of ${r.total}</span>
        <span class="pantry-bar"><span class="pantry-bar-fill" style="width:${Math.round(r.score * 100)}%"></span></span>
        <span class="pantry-card-missing">${escapeHtml(missingText)}</span>
      </button>
      ${r.missing.length ? `<button class="btn-secondary pantry-add-missing" onclick="addPantryMissing(${i})">Add missing to list</button>` : ''}
    </div>`;
  }).join('');
}

function openPantryResult(id) {
  closePantry();
  openDetail(id);
}

async function addPantryMissing(i) {
  const res = pantryResults[i];
  if (!res || !res.missing.length) return;
  await loadShoppingList();
  if (!shoppingListReady()) return;

  const lines = (res.recipe.ingredients || []).filter((line) => {
    const n = RCUtils.normalizeIngredientName(RCUtils.parseIngredientLine(String(line)).name);
    return res.missing.indexOf(n) !== -1;
  });
  const additions = lines.map((text) => ({ text: String(text), checked: false, recipeId: res.recipe.id }));
  const apply = (items) => {
    const merged = RCUtils.mergeShoppingItems(items.concat(additions.map((a) => ({ ...a }))));
    items.length = 0;
    merged.forEach((x) => items.push(x));
  };
  apply(shoppingList.items);
  await saveShoppingList(apply);
  renderShoppingList();
  toast(`${additions.length} missing item${additions.length === 1 ? '' : 's'} added to the list`);
}

// ---- Meal plan ----
async function openMealPlan() {
  planWeekOffset = 0;
  document.getElementById('plan-overlay').classList.add('on');
  overlayOpened('plan-overlay');
  await loadMealPlan();
  renderMealPlan();
}
function closeMealPlan() { document.getElementById('plan-overlay').classList.remove('on'); overlayClosed('plan-overlay'); }
async function loadMealPlan() {
  let ok;
  let data = null;
  try {
    const res = await apiFetch(`${API}/meal-plan?deviceId=${encodeURIComponent(listDeviceId())}`, { credentials: 'same-origin' });
    ok = res.ok;
    if (ok) data = await res.json();
  } catch (e) {
    ok = false;
  }
  const out = loadOutcome(ok, data);
  if (out.status === 'ok') {
    mealPlanState = 'ok';
    mealPlan = out.data && typeof out.data === 'object' && !Array.isArray(out.data) ? out.data : {};
  } else {
    // Same rule as the shopping list: a failed load leaves the plan unknown,
    // and writing a day from a guessed plan would wipe it.
    mealPlanState = 'failed';
  }
  return mealPlanState;
}
async function retryMealPlan() {
  await loadMealPlan();
  renderMealPlan();
}
// Blocks a meal-plan write while the load is failed.
function mealPlanReady() {
  if (!listWriteBlocked(mealPlanState)) return true;
  toast('Your meal plan didn\'t load — tap Retry before changing it.');
  return false;
}
function getWeekDays() {
  const days = [];
  const base = new Date();
  base.setDate(base.getDate() + planWeekOffset * 7);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    days.push(d);
  }
  return days;
}
function changePlanWeek(delta) {
  planWeekOffset += delta;
  renderMealPlan();
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function renderMealPlan() {
  const days = getWeekDays();
  const weekNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const el = document.getElementById('mp-week');
  const label = document.getElementById('mp-week-label');
  if (label) {
    label.textContent = planWeekOffset === 0
      ? 'This week'
      : (planWeekOffset > 0 ? 'In ' + planWeekOffset + ' week' + (planWeekOffset > 1 ? 's' : '') + ' • ' : '• ')
        + days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' – '
        + days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  el.innerHTML = (listWriteBlocked(mealPlanState)
    ? `<div class="mp-error" role="alert">
        <span>Your meal plan didn't load, so it can't be changed right now. Nothing on the server has been overwritten.</span>
        <button class="btn-secondary" onclick="retryMealPlan()">Retry</button>
      </div>`
    : '') + days.map((d, idx) => {
    const key = ymd(d);
    const ids = mealPlan[key] || [];
    const label = planWeekOffset === 0 && idx === 0 ? 'Today' : (planWeekOffset === 0 && idx === 1 ? 'Tomorrow' : weekNames[d.getDay()]);
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const slots = ids.map(rid => {
      const r = recipes.find(x => x.id === rid);
      const title = r ? r.title : '(deleted)';
      const ms = r ? mealStyle(r.mealType) : mealStyle('default');
      return `<div class="mp-slot" onclick="if(${r ? 'true' : 'false'}) openDetail('${rid}')"><span>${ms.emoji}</span><span class="mp-slot-title">${escapeHtml(title)}</span><button class="mp-slot-del" onclick="event.stopPropagation(); removeFromPlan('${key}', '${rid}')" title="Remove" aria-label="Remove ${escapeHtml(title)} from plan">✕</button></div>`;
    }).join('');
    return `
      <div class="mp-day">
        <div class="mp-day-head">
          <div><span class="mp-day-name">${label}</span><span class="mp-day-date">${dateStr}</span></div>
          <button class="mp-add" onclick="openPicker('${key}')">+ Add recipe</button>
        </div>
        ${slots ? `<div class="mp-slots">${slots}</div>` : '<div style="color:var(--dim);font-size:.78rem">No meals planned</div>'}
      </div>
    `;
  }).join('');
}
async function addToPlan(date, recipeId) {
  if (!mealPlanReady()) return;
  const current = mealPlan[date] || [];
  if (current.includes(recipeId)) { toast('Already in this day'); return; }
  const updated = [...current, recipeId];
  try {
    const res = await apiFetch(`${API}/meal-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ deviceId: listDeviceId(), date, recipeIds: updated }),
    });
    if (!res.ok) throw new Error('Save failed');
    mealPlan = await res.json();
    renderMealPlan();
    toast('Added to plan');
  } catch (e) {
    toast('Could not save: ' + e.message);
  }
}
async function removeFromPlan(date, recipeId) {
  if (!mealPlanReady()) return;
  const current = mealPlan[date] || [];
  const updated = current.filter(id => id !== recipeId);
  try {
    const res = await apiFetch(`${API}/meal-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ deviceId: getDeviceId(), date, recipeIds: updated }),
    });
    if (!res.ok) throw new Error('Save failed');
    mealPlan = await res.json();
    renderMealPlan();
  } catch (e) {
    toast('Could not save: ' + e.message);
  }
}

async function addWeekToShoppingList() {
  if (!mealPlanReady()) return;
  const days = getWeekDays();
  const ids = new Set();
  for (const d of days) for (const rid of (mealPlan[ymd(d)] || [])) ids.add(rid);
  if (!ids.size) { toast('No meals planned this week'); return; }
  await loadShoppingList();
  if (!shoppingListReady()) return;
  const existing = new Set((shoppingList.items || []).map(it => it.text.toLowerCase()));
  let added = 0;
  for (const rid of ids) {
    const r = recipes.find(x => x.id === rid);
    if (!r || !r.ingredients) continue;
    for (const ing of r.ingredients) {
      if (existing.has(String(ing).toLowerCase())) continue;
      shoppingList.items.push({ text: String(ing), checked: false, recipeId: rid });
      added++;
    }
  }
  await saveShoppingList();
  if (added) toast(`Added ${added} ingredient${added > 1 ? 's' : ''} for the week`);
  else toast('Everything is already on the list');
}

let pickerDate = null;
function openPicker(date) {
  pickerDate = date;
  const title = document.getElementById('picker-title');
  title.textContent = 'Pick a recipe for ' + new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const list = document.getElementById('picker-list');
  if (!recipes.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--dim);padding:20px">No recipes yet</div>';
  } else {
    list.innerHTML = recipes.map(r => {
      const ms = mealStyle(r.mealType);
      return `<button class="mp-pick" onclick="pickRecipe('${r.id}')"><span style="font-size:1.3rem">${ms.emoji}</span><span>${escapeHtml(r.title)}</span></button>`;
    }).join('');
  }
  document.getElementById('picker-overlay').classList.add('on');
  overlayOpened('picker-overlay');
}
function closePicker() { document.getElementById('picker-overlay').classList.remove('on'); overlayClosed('picker-overlay'); }
function pickRecipe(id) {
  if (!pickerDate) return;
  addToPlan(pickerDate, id);
  closePicker();
}

async function deleteRecipe(id) {
  if (!confirm('Delete this recipe for everyone?')) return;
  try {
    const res = await apiFetch(`${API}/recipes?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    closeDetail();
    // Offer Undo only when the server actually kept a copy of the recipe.
    const offer = undoOffer(true, data);
    if (offer.offer) toastWithUndo('Recipe deleted', 'Undo', () => undoDelete(id), Math.min(offer.seconds * 1000, 10000));
    else toast('Recipe deleted');
    await loadRecipes();
  } catch (e) { toast('Could not delete: ' + e.message); }
}
// Puts a just-deleted recipe back, with the same id. If the undo window has
// passed the server says so and we show that, rather than pretending.
async function undoDelete(id) {
  try {
    const res = await apiFetch(`${API}/undo-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || 'Could not undo that delete.'); return; }
    toast(`Restored ${data.title || 'recipe'}`);
    await loadRecipes();
  } catch (e) {
    toast('Could not undo: ' + e.message);
  }
}

document.getElementById('search-input').addEventListener('input', e => {
  currentSearch = e.target.value.trim();
  renderGrid();
});
document.getElementById('user-tag').addEventListener('click', () => {
  const cur = getUser();
  const n = prompt('Your display name:', cur === 'Anonymous' ? '' : cur);
  if (n !== null) setUser(n.trim() || 'Anonymous');
});

document.getElementById('upload-overlay').addEventListener('click', e => { if (e.target.id === 'upload-overlay' && !isProcessing) cancelUpload(); });
document.getElementById('import-overlay').addEventListener('click', e => { if (e.target.id === 'import-overlay') closeImport(); });
document.getElementById('detail-overlay').addEventListener('click', e => { if (e.target.id === 'detail-overlay') closeDetail(); });
document.getElementById('shopping-overlay').addEventListener('click', e => { if (e.target.id === 'shopping-overlay') closeShoppingList(); });
document.getElementById('plan-overlay').addEventListener('click', e => { if (e.target.id === 'plan-overlay') closeMealPlan(); });
document.getElementById('picker-overlay').addEventListener('click', e => { if (e.target.id === 'picker-overlay') closePicker(); });
document.getElementById('credit-overlay').addEventListener('click', e => { if (e.target.id === 'credit-overlay') cancelPhotoUpload(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    // Trap Tab inside the topmost open overlay
    const top = openOverlayStack[openOverlayStack.length - 1];
    const el = top ? document.getElementById(top) : null;
    if (el && el.classList.contains('on')) {
      const focusables = [...el.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((f) => !f.disabled && f.getClientRects().length > 0);
      if (focusables.length) {
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    return;
  }
  if (e.key === 'Escape') {
    if (isProcessing) return;
    // Close only the TOPMOST open overlay, like the Back button does.
    // Closing every overlay scrambles focus restoration and leaves the
    // history stack with stale entries.
    for (let i = openOverlayStack.length - 1; i >= 0; i--) {
      const id = openOverlayStack[i];
      const el = document.getElementById(id);
      if (el && el.classList.contains('on')) { closeOverlayById(id); return; }
      openOverlayStack.splice(i, 1); // stale entry: overlay already gone
    }
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('SW registered:', reg.scope);
        // When a new service worker is ready, offer a reload.
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast();
            }
          });
        });
        if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast();
      })
      .catch(err => console.error('SW registration failed:', err));
  });
  // Reload only when the user tapped the update toast. A controller
  // swap by itself must never reload the page mid-use (upload queue!).
  window.updateRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!window.updateRequested) return;
    window.updateRequested = false;
    window.location.reload();
  });
}
function showUpdateToast() {
  const t = document.getElementById('toast');
  t.textContent = 'Update available — tap to reload';
  t.classList.add('on');
  t.style.pointerEvents = 'auto';
  t.style.cursor = 'pointer';
  // One-shot handler: it nulls itself so later toasts (incl. Undo)
  // can never inherit the reload behaviour.
  t.onclick = () => {
    t.onclick = null;
    window.updateRequested = true;
    navigator.serviceWorker.getRegistration().then(reg => {
      if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      else window.location.reload();
    });
  };
}
