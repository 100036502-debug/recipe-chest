
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
  const s = String(ing).replace(/(\d*)([½¼¾⅓⅔⅛])/g, (_, whole, frac) => {
    const value = (whole ? parseInt(whole, 10) : 0) + FRACTION_CHARS[frac];
    return String(value);
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

let toastActionHandler = null;
function toast(msg) {
  const t = document.getElementById('toast');
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
  overlayClosed('upload-overlay');
  if (isProcessing) {
    if (!confirm('Stop processing the remaining images? Already-saved recipes will stay.')) return;
    cancelRequested = true;
  }
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
async function startBatch() {
  if (isProcessing) return;
  const ready = uploadQueue.filter(i => i.status === 'ready');
  if (!ready.length) return;
  const name = document.getElementById('uploader-name').value.trim() || 'Anonymous';
  setUser(name);
  isProcessing = true;
  cancelRequested = false;
  updateQueueUI();
  let success = 0, failed = 0, duplicates = 0;
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
  if (currentFilter === 'favorites') filtered = filtered.filter(r => r.favorite === true);
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
    ['newest', 'oldest', 'az', 'quickest'].map(s =>
      `<option value="${s}"${currentSort === s ? ' selected' : ''}>${({ newest: 'Newest', oldest: 'Oldest', az: 'A to Z', quickest: 'Quickest' })[s]}</option>`
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
            <span>${r.addedBy ? 'by ' + escapeHtml(r.addedBy) : ''}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
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

async function openCookMode(id) {
  const r = recipes.find(x => x.id === id);
  if (!r) { toast('Recipe not found'); return; }

  const ms = mealStyle(r.mealType);
  const scaleFactor = (currentScaling && currentScaling.recipeId === r.id) ? currentScaling.factor : 1;

  const ingredientsHtml = (r.ingredients || []).map(ing => `<li>${scaleIngredientLine(ing, scaleFactor)}</li>`).join('');

  const stepsHtml = (r.instructions || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');

  const metaBits = [];
  if (r.prepTime) metaBits.push(`<span class="meta-pill"><span class="k">Prep:</span> ${escapeHtml(r.prepTime)}</span>`);
  if (r.cookTime) metaBits.push(`<span class="meta-pill"><span class="k">Cook:</span> ${escapeHtml(r.cookTime)}</span>`);
  if (r.servings) metaBits.push(`<span class="meta-pill"><span class="k">Serves:</span> ${escapeHtml(r.servings)}</span>`);

  const html = `
    <button class="cook-close" onclick="closeCookMode()" title="Close" aria-label="Close cook mode">✕</button>
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
    ${r.instructions && r.instructions.length ? `
      <h2 class="cook-section-h">Instructions</h2>
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
}
function closeShoppingList() { document.getElementById('shopping-overlay').classList.remove('on'); overlayClosed('shopping-overlay'); }
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
    const res = await apiFetch(`${API}/shopping-list?deviceId=${encodeURIComponent(getDeviceId())}`, { credentials: 'same-origin' });
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
function renderShoppingList() {
  const el = document.getElementById('sl-list');
  const items = shoppingList.items || [];
  const blocked = listWriteBlocked(shoppingListState);
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
  el.innerHTML = banner + items.map((it, i) => `
    <div class="sl-item ${it.checked ? 'checked' : ''}">
      <input type="checkbox" ${it.checked ? 'checked' : ''} onchange="toggleShoppingItem(${i})">
      <span class="sl-text">${escapeHtml(it.text)}</span>
      <button class="sl-del" onclick="removeShoppingItem(${i})" title="Remove" aria-label="Remove item">✕</button>
    </div>
  `).join('');
}
// Blocks a shopping-list write while the load is failed, with a message that
// says what to do, instead of saving an empty-looking list over the real one.
function shoppingListReady() {
  if (!listWriteBlocked(shoppingListState)) return true;
  toast('Your list didn\'t load — open Shopping List and tap Retry first.');
  return false;
}
async function saveShoppingList() {
  if (!shoppingListReady()) return;
  try {
    const res = await apiFetch(`${API}/shopping-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ deviceId: getDeviceId(), items: shoppingList.items }),
    });
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
  saveShoppingList();
}
function toggleShoppingItem(i) {
  if (!shoppingList.items[i]) return;
  if (!shoppingListReady()) return;
  shoppingList.items[i].checked = !shoppingList.items[i].checked;
  saveShoppingList();
}
function removeShoppingItem(i) {
  if (!shoppingListReady()) return;
  shoppingList.items.splice(i, 1);
  saveShoppingList();
}
async function clearShoppingList() {
  if (!confirm('Clear the entire shopping list?')) return;
  if (!shoppingListReady()) return;
  try {
    await apiFetch(`${API}/shopping-list?deviceId=${encodeURIComponent(getDeviceId())}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    shoppingList = { items: [] };
    renderShoppingList();
  } catch (e) {
    toast('Could not clear: ' + e.message);
  }
}
async function addRecipeToShoppingList(id) {
  const r = recipes.find(x => x.id === id);
  if (!r || !r.ingredients) return;
  await loadShoppingList();
  if (!shoppingListReady()) return;
  const existing = new Set((shoppingList.items || []).map(it => it.text.toLowerCase()));
  let added = 0;
  for (const ing of r.ingredients) {
    if (existing.has(String(ing).toLowerCase())) continue;
    shoppingList.items.push({ text: String(ing), checked: false, recipeId: id });
    added++;
  }
  await saveShoppingList();
  if (added) toast(`Added ${added} ingredient${added > 1 ? 's' : ''} from ${r.title}`);
  else toast('All ingredients already on the list');
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
    const res = await apiFetch(`${API}/meal-plan?deviceId=${encodeURIComponent(getDeviceId())}`, { credentials: 'same-origin' });
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
      body: JSON.stringify({ deviceId: getDeviceId(), date, recipeIds: updated }),
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
    cancelUpload(); cancelPhotoUpload(); closeImport(); closeDetail(); closeShoppingList(); closeMealPlan(); closePicker();
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
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
function showUpdateToast() {
  const t = document.getElementById('toast');
  t.textContent = 'Update available — tap to reload';
  t.classList.add('on');
  t.style.pointerEvents = 'auto';
  t.style.cursor = 'pointer';
  t.onclick = () => {
    navigator.serviceWorker.getRegistration().then(reg => {
      if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      else window.location.reload();
    });
  };
}
