// The public share page. Reads /s/<token>, asks /api/share-view for exactly the
// whitelisted fields and renders them. Every value goes through escapeHtml or
// safeHref before it reaches the DOM.
(function () {
  var RC = window.RCUtils || {};
  var esc = RC.escapeHtml || function (v) { return String(v == null ? '' : v); };
  var safe = RC.safeHref || function () { return ''; };

  var root = document.getElementById('share-root');
  if (!root) return;

  var TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
  var token = String(location.pathname || '').replace(/^\/s\//, '').replace(/\/+$/, '');

  function message(text) {
    root.innerHTML = '<div class="share-error">' + esc(text) + '</div>';
  }

  function pill(label, value) {
    if (!value) return '';
    return '<span class="meta-pill"><span class="k">' + esc(label) + ':</span> ' + esc(value) + '</span>';
  }

  function heroHtml(data) {
    if (data.hasUserPhoto) {
      return '<div class="share-hero"><img src="/api/share-photo?token=' + encodeURIComponent(token) +
        '&amp;size=full" alt="' + esc(data.title) + '"></div>';
    }
    var image = data.image;
    var url = image && safe(image.url);
    if (!url) return '';
    var credit = '';
    if (image.photographer) {
      var who = esc(image.photographer);
      if (safe(image.photographerUrl)) {
        who = '<a href="' + esc(safe(image.photographerUrl)) + '" target="_blank" rel="noopener noreferrer">' + who + '</a>';
      }
      credit = '<p class="share-credit">Photo by ' + who +
        (safe(image.photoUrl) ? ' on <a href="' + esc(safe(image.photoUrl)) + '" target="_blank" rel="noopener noreferrer">Unsplash</a>' : '') +
        '</p>';
    }
    return '<div class="share-hero"><img src="' + esc(url) + '" alt="' + esc(data.title) + '"></div>' + credit;
  }

  function render(data) {
    var pills = pill('Prep', data.prepTime) + pill('Cook', data.cookTime) + pill('Serves', data.servings);
    var ingredients = (data.ingredients || []).map(function (line) {
      return '<li>' + esc(line) + '</li>';
    }).join('');
    var steps = (data.instructions || []).map(function (line) {
      return '<li>' + esc(line) + '</li>';
    }).join('');
    var source = safe(data.sourceUrl);

    root.innerHTML =
      heroHtml(data) +
      '<h1 class="share-title">' + esc(data.title) + '</h1>' +
      (data.description ? '<p class="share-desc">' + esc(data.description) + '</p>' : '') +
      (pills ? '<div class="share-meta">' + pills + '</div>' : '') +
      (ingredients ? '<h2 class="share-h">Ingredients</h2><ul class="share-ing">' + ingredients + '</ul>' : '') +
      (steps ? '<h2 class="share-h">Instructions</h2><ol class="share-steps">' + steps + '</ol>' : '') +
      (data.notes ? '<h2 class="share-h">Notes</h2><p class="share-notes">' + esc(data.notes) + '</p>' : '') +
      (source ? '<p class="share-source"><a href="' + esc(source) + '" target="_blank" rel="noopener noreferrer">Original source</a></p>' : '') +
      '<div class="share-actions"><button type="button" class="btn-secondary" id="share-print">Print</button></div>';

    var print = document.getElementById('share-print');
    if (print) print.addEventListener('click', function () { window.print(); });
  }

  if (!TOKEN_RE.test(token)) {
    message('This link is no longer available.');
    return;
  }

  fetch('/api/share-view?token=' + encodeURIComponent(token), {
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  }).then(function (res) {
    if (res.status === 404) {
      message('This link is no longer available.');
      return null;
    }
    if (!res.ok) {
      message('This recipe could not be loaded. Try again later.');
      return null;
    }
    return res.json();
  }).then(function (data) {
    if (data) render(data);
  }).catch(function () {
    message('This recipe could not be loaded. Check your connection and try again.');
  });
})();
