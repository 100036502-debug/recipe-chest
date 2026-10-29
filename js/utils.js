// Pure client-side helpers shared by several features.
//
// A CLASSIC script (not a module) so it loads exactly like js/app.js: no build
// step, no import syntax, works with the inline onclick handlers. It assigns
// one global, RCUtils, and does nothing else.
//
// Two rules keep it testable:
//   - it never touches the DOM at load
//   - node:test loads THIS file (see test/helpers/load-client.js), so the code
//     under test is byte-for-byte what the browser runs.
(function (root) {
  'use strict';

  // ---- quantities --------------------------------------------------------

  // Vulgar fractions, so "1½ cups" parses the same as "1 1/2 cups".
  const FRACTIONS = {
    '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3,
    '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8, '⅕': 1 / 5, '⅖': 2 / 5,
  };
  const FRACTION_CLASS = '[\u00BC-\u00BE\u2150-\u215E]';

  // Canonical unit spellings. Anything not listed here is treated as part of
  // the ingredient name, which is what makes "3 eggs" work.
  const UNIT_ALIASES = {
    tsp: ['tsp', 'tsps', 'teaspoon', 'teaspoons'],
    tbsp: ['tbsp', 'tbsps', 'tbs', 'tablespoon', 'tablespoons'],
    cup: ['cup', 'cups'],
    oz: ['oz', 'ounce', 'ounces'],
    lb: ['lb', 'lbs', 'pound', 'pounds'],
    g: ['g', 'gr', 'gram', 'grams', 'gramme', 'grammes'],
    kg: ['kg', 'kgs', 'kilogram', 'kilograms'],
    ml: ['ml', 'mls', 'millilitre', 'millilitres', 'milliliter', 'milliliters'],
    l: ['l', 'litre', 'litres', 'liter', 'liters'],
    clove: ['clove', 'cloves'],
    can: ['can', 'cans'],
    pinch: ['pinch', 'pinches'],
    stick: ['stick', 'sticks'],
    slice: ['slice', 'slices'],
    piece: ['piece', 'pieces'],
  };

  const UNIT_LOOKUP = {};
  Object.keys(UNIT_ALIASES).forEach(function (canonical) {
    UNIT_ALIASES[canonical].forEach(function (alias) {
      UNIT_LOOKUP[alias] = canonical;
    });
  });

  function canonicalUnit(word) {
    const key = String(word || '').toLowerCase().replace(/\.+$/, '').trim();
    return UNIT_LOOKUP[key] || '';
  }

  // Reads a leading quantity. A range keeps the lower number: "2-3 cloves"
  // means two cloves you definitely have, not three you might.
  function readQty(s) {
    let m = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)\b/);
    if (m) return { value: Number(m[1]) + Number(m[2]) / Number(m[3]), length: m[0].length };

    m = s.match(new RegExp('^(\\d+)\\s*(' + FRACTION_CLASS + ')'));
    if (m && FRACTIONS[m[2]]) {
      return { value: Number(m[1]) + FRACTIONS[m[2]], length: m[0].length };
    }

    m = s.match(new RegExp('^(' + FRACTION_CLASS + ')'));
    if (m && FRACTIONS[m[1]]) return { value: FRACTIONS[m[1]], length: m[0].length };

    m = s.match(/^(\d+)\s*\/\s*(\d+)\b/);
    if (m) return { value: Number(m[1]) / Number(m[2]), length: m[0].length };

    m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:[.,]\d+)?)/i);
    if (m) {
      const a = Number(m[1].replace(',', '.'));
      const b = Number(m[2].replace(',', '.'));
      return { value: Math.min(a, b), length: m[0].length };
    }

    m = s.match(/^(\d+(?:[.,]\d+)?)/);
    if (m) return { value: Number(m[1].replace(',', '.')), length: m[0].length };

    return null;
  }

  // "2 cups flour, sifted" -> { qty: 2, unit: 'cup', name: 'flour' }
  // "a pinch of salt"      -> { qty: null, unit: 'pinch', name: 'salt' }
  // "3 eggs"               -> { qty: 3, unit: '', name: 'eggs' }
  function parseIngredientLine(line) {
    const raw = String(line == null ? '' : line).trim();
    const out = { qty: null, unit: '', name: raw, raw };
    if (!raw) return out;

    let rest = raw;

    const got = readQty(rest);
    if (got) {
      out.qty = got.value;
      rest = rest.slice(got.length).trim();
    } else {
      // "a pinch of salt" has a unit but no number.
      const article = rest.match(/^(?:a|an)\s+/i);
      if (article) rest = rest.slice(article[0].length);
    }

    const unitMatch = rest.match(/^([A-Za-z.]+)(?:\s+([\s\S]*))?$/);
    if (unitMatch) {
      const unit = canonicalUnit(unitMatch[1]);
      if (unit) {
        out.unit = unit;
        rest = (unitMatch[2] || '').trim();
      }
    }

    let name = rest.replace(/^of\s+/i, '');
    const comma = name.indexOf(',');
    if (comma !== -1) name = name.slice(0, comma);
    out.name = name.trim();
    return out;
  }

  // ---- formatting --------------------------------------------------------

  // Moved here from js/app.js so the scaling helpers and the new shopping list
  // share one implementation. Whole numbers stay whole, common fractions stay
  // readable, everything else gets two decimals.
  function formatQty(n) {
    if (!isFinite(n) || n <= 0) return '';
    if (Math.abs(n - Math.round(n)) < 0.01) return String(Math.round(n));
    const whole = Math.floor(n);
    const frac = n - whole;
    const common = [[1 / 8, '1/8'], [1 / 4, '1/4'], [1 / 3, '1/3'], [1 / 2, '1/2'], [2 / 3, '2/3'], [3 / 4, '3/4']];
    for (const pair of common) {
      if (Math.abs(frac - pair[0]) < 0.03) return whole > 0 ? whole + ' ' + pair[1] : pair[1];
    }
    return n.toFixed(2).replace(/\.?0+$/, '');
  }

  // ---- ingredient names --------------------------------------------------

  const PREP_WORDS = [
    'chopped', 'diced', 'minced', 'sliced', 'grated', 'shredded', 'crushed',
    'fresh', 'freshly', 'large', 'small', 'medium', 'finely', 'roughly',
    'thinly', 'coarsely', 'to taste', 'optional', 'divided', 'plus more',
    'or more', 'or less', 'packed', 'heaped', 'level', 'ripe', 'boneless',
    'skinless', 'extra', 'virgin', 'light', 'dark',
  ];

  // Longest first so "confectioners sugar" wins over "caster sugar" style
  // partial matches.
  const SYNONYMS = [
    ['confectioners sugar', 'powdered sugar'],
    ['confectioner sugar', 'powdered sugar'],
    ['caster sugar', 'sugar'],
    ['scallion', 'green onion'],
    ['coriander', 'cilantro'],
    ['garbanzo bean', 'chickpea'],
    ['garbanzo', 'chickpea'],
    ['courgette', 'zucchini'],
    ['aubergine', 'eggplant'],
  ];

  // English plurals, kept deliberately conservative: anything ending in ss or
  // us is left alone ("asparagus", "grass").
  function singular(word) {
    if (word.length <= 3) return word;
    if (/ss$/.test(word) || /us$/.test(word) || /is$/.test(word)) return word;
    if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
    if (/oes$/.test(word)) return word.slice(0, -2);
    if (/ves$/.test(word)) return word.slice(0, -3) + 'f';
    if (/(ses|xes|ches|shes|zes)$/.test(word)) return word.slice(0, -2);
    if (/s$/.test(word)) return word.slice(0, -1);
    return word;
  }

  function normalizeIngredientName(name) {
    let s = String(name == null ? '' : name).toLowerCase();
    s = s.replace(/\([^)]*\)/g, ' ');
    s = s.replace(/[^a-z0-9\s-]/g, ' ');

    PREP_WORDS.forEach(function (word) {
      s = s.replace(new RegExp('(^|\\s)' + word.replace(/ /g, '\\s+') + '(?=\\s|$)', 'g'), ' ');
    });

    s = s.replace(/\s+/g, ' ').trim();

    // Singular first, then synonyms, so "scallions" and "chickpeas" match the
    // singular keys in the map.
    s = s.split(' ').map(singular).join(' ');

    SYNONYMS.forEach(function (pair) {
      s = s.replace(new RegExp('\\b' + pair[0].replace(/ /g, '\\s+') + '\\b', 'g'), pair[1]);
    });

    return s.replace(/\s+/g, ' ').trim();
  }


  // ---- timers (pure: no DOM, no setInterval) ----------------------------
  // A step like "simmer for 10-12 minutes" yields one timer. Ranges use the
  // lower number so the alarm is early rather than late, while the label keeps
  // the range so the cook still sees what the recipe said.
  var UNIT_SECONDS = { sec: 1, min: 60, hr: 3600 };
  var UNIT_SHORT = { second: 'sec', seconds: 'sec', sec: 'sec', secs: 'sec',
    minute: 'min', minutes: 'min', min: 'min', mins: 'min',
    hour: 'hr', hours: 'hr', hr: 'hr', hrs: 'hr' };
  var UNICODE_FRACTIONS = { '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8 };
  var MAX_TIMER_SECONDS = 24 * 60 * 60;

  function numberFromText(text) {
    var t = String(text).trim();
    var m = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
    if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
    m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (m) return Number(m[1]) / Number(m[2]);
    m = t.match(/^(\d+(?:\.\d+)?)\s*([\u00BC-\u00BE\u2150-\u215E])$/);
    if (m) return Number(m[1]) + UNICODE_FRACTIONS[m[2]];
    m = t.match(/^([\u00BC-\u00BE\u2150-\u215E])$/);
    if (m) return UNICODE_FRACTIONS[m[1]];
    m = t.match(/^(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]);
    return NaN;
  }

  // A readable label for a plain duration: "half an hour" reads better as 30 min.
  function labelFromSeconds(seconds) {
    if (seconds >= 3600 && seconds % 3600 === 0) return (seconds / 3600) + ' hr';
    if (seconds >= 60 && seconds % 60 === 0) return (seconds / 60) + ' min';
    return seconds + ' sec';
  }

  function parseTimersFromStep(text) {
    var src = String(text == null ? '' : text);
    var found = [];
    var seen = {};

    function push(label, seconds, matchText) {
      if (!isFinite(seconds) || seconds <= 0 || seconds > MAX_TIMER_SECONDS) return;
      var key = matchText.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      found.push({ label: label, seconds: Math.round(seconds), text: matchText.trim() });
    }

    // "an hour", "a minute", "half an hour" — no digits involved
    var article = /\b(half\s+an?|an?)\s+(hours?|minutes?|seconds?)\b/gi;
    var am;
    while ((am = article.exec(src))) {
      var unit = am[2].toLowerCase().replace(/s$/, '');
      var shortUnit = UNIT_SHORT[unit + 's'] || UNIT_SHORT[unit] || 'min';
      var isHalf = /^half/i.test(am[1]);
      var seconds = (isHalf ? 0.5 : 1) * UNIT_SECONDS[shortUnit];
      push(labelFromSeconds(seconds), seconds, am[0]);
    }

    // numbers, with an optional range: "25 minutes", "10-12 min", "1 1/2 hours"
    var NUM = '(?:\\d+\\s+\\d+\\s*\\/\\s*\\d+|\\d+\\s*\\/\\s*\\d+|\\d+(?:\\.\\d+)?\\s*[\\u00BC-\\u00BE\\u2150-\\u215E]|[\\u00BC-\\u00BE\\u2150-\\u215E]|\\d+(?:\\.\\d+)?)';
    var re = new RegExp('(' + NUM + ')(?:\\s*(?:-|\\u2013|\\u2014|to)\\s*(' + NUM + '))?\\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\\b', 'gi');
    var m;
    while ((m = re.exec(src))) {
      var low = numberFromText(m[1]);
      var high = m[2] ? numberFromText(m[2]) : NaN;
      var canonical = UNIT_SHORT[m[3].toLowerCase()];
      if (!canonical || !isFinite(low)) continue;
      var label;
      if (isFinite(high)) {
        label = m[1].trim() + '-' + m[2].trim() + ' ' + canonical;
      } else {
        label = m[1].trim() + ' ' + canonical;
      }
      push(label, low * UNIT_SECONDS[canonical], m[0]);
    }

    return found;
  }

  // Timers are plain objects so they survive a round trip through localStorage.
  function createTimer(opts) {
    var o = opts || {};
    var seconds = Math.max(0, Math.round(Number(o.seconds) || 0));
    var now = Number(o.now) || 0;
    return {
      id: String(o.id == null ? '' : o.id),
      label: String(o.label == null ? '' : o.label),
      totalMs: seconds * 1000,
      endsAt: now + seconds * 1000,
      pausedRemainingMs: null,
    };
  }

  function pauseTimer(timer, now) {
    if (!timer || timer.pausedRemainingMs != null) return timer;
    var out = {};
    for (var k in timer) out[k] = timer[k];
    out.pausedRemainingMs = Math.max(0, timer.endsAt - (Number(now) || 0));
    return out;
  }

  function resumeTimer(timer, now) {
    if (!timer || timer.pausedRemainingMs == null) return timer;
    var out = {};
    for (var k in timer) out[k] = timer[k];
    out.endsAt = (Number(now) || 0) + timer.pausedRemainingMs;
    out.pausedRemainingMs = null;
    return out;
  }

  function addTime(timer, ms, now) {
    if (!timer) return timer;
    var delta = Math.round(Number(ms) || 0);
    if (timer.pausedRemainingMs != null) {
      var paused = {};
      for (var k in timer) paused[k] = timer[k];
      paused.pausedRemainingMs = Math.max(0, timer.pausedRemainingMs + delta);
      return paused;
    }
    var out = {};
    for (var key in timer) out[key] = timer[key];
    // Adding time to a finished timer restarts it from now.
    var base = Math.max(timer.endsAt, Number(now) || 0);
    out.endsAt = base + delta;
    return out;
  }

  function remainingMs(timer, now) {
    if (!timer) return 0;
    if (timer.pausedRemainingMs != null) return Math.max(0, timer.pausedRemainingMs);
    return Math.max(0, Number(timer.endsAt) - (Number(now) || 0));
  }

  function isDone(timer, now) {
    return remainingMs(timer, now) === 0;
  }

  function formatDuration(ms) {
    var total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  // Cook-mode ticks and timers are only good for a day: stale ones confuse more
  // than they help.
  function isCookStateFresh(state, now, maxAgeMs) {
    var ts = state && Number(state.ts);
    if (!isFinite(ts)) return false;
    var age = (Number(now) || 0) - ts;
    var limit = maxAgeMs == null ? 24 * 60 * 60 * 1000 : maxAgeMs;
    return age >= 0 && age < limit;
  }

  root.RCUtils = {
    parseIngredientLine: parseIngredientLine,
    formatQty: formatQty,
    normalizeIngredientName: normalizeIngredientName,
    parseTimersFromStep: parseTimersFromStep,
    createTimer: createTimer,
    pauseTimer: pauseTimer,
    resumeTimer: resumeTimer,
    addTime: addTime,
    remainingMs: remainingMs,
    isDone: isDone,
    formatDuration: formatDuration,
    isCookStateFresh: isCookStateFresh,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
