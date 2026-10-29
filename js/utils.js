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


  // ---- aisles ----------------------------------------------------------
  // Stored items stay a flat list; the aisle is worked out for display only, so
  // changing this table never rewrites anyone's saved data.
  var AISLE_KEYWORDS = {
    'Produce': ['bell pepper', 'sweet potato', 'spring onion', 'onion', 'garlic', 'tomato', 'lettuce', 'spinach',
      'apple', 'lemon', 'lime', 'potato', 'carrot', 'basil', 'cilantro', 'parsley', 'cucumber', 'mushroom',
      'celery', 'broccoli', 'zucchini', 'avocado', 'banana', 'berry', 'orange', 'ginger', 'corn', 'cabbage',
      'kale', 'thyme', 'rosemary', 'scallion', 'shallot', 'pear', 'peach', 'grape', 'melon', 'beet', 'radish',
      'leek', 'cauliflower', 'squash', 'mint', 'dill', 'chive'],
    'Meat & seafood': ['ground beef', 'ground turkey', 'chicken breast', 'chicken thigh', 'chicken', 'beef',
      'pork', 'bacon', 'salmon', 'shrimp', 'sausage', 'turkey', 'lamb', 'ham', 'tuna', 'cod', 'prawn', 'steak',
      'mince', 'chorizo', 'prosciutto', 'anchovy', 'crab', 'fish', 'lobster', 'salami', 'pepperoni'],
    'Dairy & eggs': ['sour cream', 'cream cheese', 'milk', 'butter', 'cheese', 'egg', 'yogurt',
      'cream', 'mozzarella', 'parmesan', 'cheddar', 'feta', 'ricotta', 'buttermilk', 'margarine', 'ghee'],
    'Bakery': ['bread', 'bun', 'baguette', 'tortilla', 'pita', 'roll', 'bagel', 'croissant', 'naan',
      'sourdough', 'crouton', 'brioche', 'focaccia', 'wrap'],
    'Frozen': ['frozen', 'frozen pea', 'frozen corn', 'ice cream', 'popsicle', 'frozen pizza', 'frozen berry'],
    'Pantry': ['tomato paste', 'peanut butter', 'soy sauce', 'olive oil', 'flour', 'sugar', 'rice', 'pasta',
      'oil', 'vinegar', 'bean', 'broth', 'stock', 'canned', 'noodle', 'oat', 'lentil', 'quinoa', 'honey',
      'cereal', 'cracker', 'chickpea', 'coconut milk', 'tahini', 'mustard', 'ketchup', 'mayonnaise', 'walnut',
      'almond', 'cashew', 'raisin', 'cornstarch'],
    'Spices & baking': ['baking powder', 'baking soda', 'chili powder', 'black pepper', 'cayenne', 'paprika',
      'cinnamon', 'cumin', 'oregano', 'vanilla', 'yeast', 'nutmeg', 'turmeric', 'cardamom', 'saffron',
      'allspice', 'salt', 'pepper', 'coriander', 'fennel seed', 'bay leaf', 'clove', 'extract', 'sprinkle'],
    'Drinks': ['sparkling water', 'orange juice', 'apple juice', 'lemonade', 'coffee', 'tea', 'wine', 'beer',
      'soda', 'cola', 'cider', 'water', 'juice', 'whisky', 'vodka', 'rum', 'seltzer', 'prosecco'],
  };
  var AISLE_OF = {};
  var AISLE_KEYS = [];
  Object.keys(AISLE_KEYWORDS).forEach(function (aisle) {
    AISLE_KEYWORDS[aisle].forEach(function (kw) {
      if (!AISLE_OF[kw]) AISLE_OF[kw] = aisle;
      AISLE_KEYS.push(kw);
    });
  });
  // Longest phrase first, so "black pepper" beats "pepper" and "ice cream"
  // beats "cream".
  AISLE_KEYS.sort(function (a, b) {
    var aw = a.split(' ').length;
    var bw = b.split(' ').length;
    return bw - aw || b.length - a.length;
  });

  function classifyAisle(text) {
    var name = normalizeIngredientName(String(text == null ? '' : text));
    if (!name) return 'Other';
    for (var i = 0; i < AISLE_KEYS.length; i++) {
      var kw = AISLE_KEYS[i];
      if (new RegExp('\\b' + kw.replace(/ /g, '\\s+') + '\\b').test(name)) {
        return AISLE_OF[kw];
      }
    }
    return 'Other';
  }

  // ---- merging shopping list lines -------------------------------------
  // Volume units convert among themselves (tsp/tbsp/cup), and so do the two
  // weight systems (oz/lb and g/kg). Volume is never added to weight, and
  // imperial is never added to metric: a wrong sum is worse than two lines.
  var VOLUME_IN_TSP = { tsp: 1, tbsp: 3, cup: 48 };
  var WEIGHT_IN_OZ = { oz: 1, lb: 16 };
  var WEIGHT_IN_G = { g: 1, kg: 1000 };

  function unitFamily(unit, qty) {
    if (VOLUME_IN_TSP[unit]) return 'volume';
    if (WEIGHT_IN_OZ[unit]) return 'imperial-weight';
    if (WEIGHT_IN_G[unit]) return 'metric-weight';
    if (unit) return 'unit:' + unit;
    return qty == null ? 'none' : 'count';
  }

  function toBase(qty, unit) {
    if (VOLUME_IN_TSP[unit]) return qty * VOLUME_IN_TSP[unit];
    if (WEIGHT_IN_OZ[unit]) return qty * WEIGHT_IN_OZ[unit];
    if (WEIGHT_IN_G[unit]) return qty * WEIGHT_IN_G[unit];
    return qty;
  }

  function fromBase(total, family, unit) {
    if (family === 'volume') {
      if (total < 3) return { qty: total, unit: 'tsp' };
      if (total < 12) return { qty: total / 3, unit: 'tbsp' };
      return { qty: total / 48, unit: 'cup' };
    }
    if (family === 'imperial-weight') {
      return total < 16 ? { qty: total, unit: 'oz' } : { qty: total / 16, unit: 'lb' };
    }
    if (family === 'metric-weight') {
      return total < 1000 ? { qty: total, unit: 'g' } : { qty: total / 1000, unit: 'kg' };
    }
    return { qty: total, unit: unit };
  }

  function mergeShoppingItems(items) {
    var list = Array.isArray(items) ? items : [];
    var groups = [];
    var index = {};

    list.forEach(function (item) {
      var text = String((item && item.text) || '');
      var parsed = parseIngredientLine(text);
      var key = normalizeIngredientName(parsed.name || text);
      var family = unitFamily(parsed.unit, parsed.qty);
      var slot = key + '|' + family;

      // === undefined, not falsy: index 0 is a valid slot and !0 is true.
      if (index[slot] === undefined) {
        index[slot] = groups.length;
        groups.push({
          key: key, family: family, displayName: parsed.name || text, unit: parsed.unit,
          hasQty: false, total: 0,
          allChecked: true, any: false, recipeId: (item && item.recipeId) || null, raw: text,
        });
      }
      var g = groups[index[slot]];
      if (parsed.qty != null) {
        g.total += toBase(parsed.qty, parsed.unit);
        g.hasQty = true;
        if (!g.unit) g.unit = parsed.unit;
      }
      if (item && item.checked) g.any = true; else g.allChecked = false;
    });

    return groups.map(function (g) {
      var out = { text: g.raw, checked: g.allChecked, recipeId: g.recipeId };
      if (!g.hasQty) {
        out.text = g.displayName || g.raw;
        return out;
      }
      var converted = fromBase(g.total, g.family, g.unit);
      var qtyText = formatQty(converted.qty);
      var unitText = converted.unit ? ' ' + converted.unit : '';
      out.text = ((qtyText + unitText).trim() + ' ' + g.displayName).trim();
      return out;
    });
  }


  // ---- what can I make? ------------------------------------------------
  // A pantry item covers an ingredient when either name contains the other as
  // a whole word, so "chicken" covers "chicken breast" and "cheese" covers
  // "cheddar cheese". Whole words only keeps "oil" out of "boiled".
  var PANTRY_BASICS = ['salt', 'pepper', 'black pepper', 'water', 'oil', 'olive oil',
    'vegetable oil', 'cooking spray', 'ice'];

  function containsWord(haystack, needle) {
    if (!haystack || !needle) return false;
    var escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i').test(haystack);
  }

  function pantryCovers(pantryNames, name) {
    for (var i = 0; i < pantryNames.length; i++) {
      var p = pantryNames[i];
      if (!p) continue;
      if (p === name) return true;
      if (containsWord(name, p) || containsWord(p, name)) return true;
    }
    return false;
  }

  function matchRecipesToPantry(recipes, pantry, options) {
    var opts = options || {};
    var assumeBasics = opts.assumeBasics !== false;
    var minScore = opts.minScore == null ? 0.5 : Number(opts.minScore);

    var pantryNames = (Array.isArray(pantry) ? pantry : [])
      .map(function (p) { return normalizeIngredientName(String(p || '')); })
      .filter(Boolean);
    if (assumeBasics) PANTRY_BASICS.forEach(function (b) { pantryNames.push(b); });

    var out = [];
    (Array.isArray(recipes) ? recipes : []).forEach(function (recipe) {
      if (!recipe || typeof recipe !== 'object') return;
      var lines = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
      var names = lines
        .map(function (line) { return normalizeIngredientName(parseIngredientLine(String(line || '')).name); })
        .filter(Boolean);
      if (!names.length) return; // nothing to cook, nothing to score

      var haveNames = [];
      var missing = [];
      names.forEach(function (n) {
        if (pantryCovers(pantryNames, n)) haveNames.push(n); else missing.push(n);
      });

      var score = haveNames.length / names.length;
      if (!(score >= minScore)) return;

      out.push({
        recipe: recipe, have: haveNames.length, total: names.length,
        score: score, missing: missing, haveNames: haveNames,
      });
    });

    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.missing.length !== b.missing.length) return a.missing.length - b.missing.length;
      var favA = a.recipe.favorite ? 1 : 0, favB = b.recipe.favorite ? 1 : 0;
      if (favB !== favA) return favB - favA;
      return (Number(b.recipe.createdAt) || 0) - (Number(a.recipe.createdAt) || 0);
    });

    return out;
  }


  // ---- cooking log stats ------------------------------------------------
  // Everything the detail view and the cards need, derived from the log so the
  // stored shape stays { id, date, rating, note, by }.
  function cookStats(cookLog) {
    var list = (Array.isArray(cookLog) ? cookLog : []).filter(function (e) {
      return e && typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date);
    });
    if (!list.length) return { count: 0, lastDate: null, avgRating: null };

    var lastDate = list.reduce(function (best, e) { return e.date > best ? e.date : best; }, list[0].date);
    var ratings = list
      .map(function (e) { return e.rating; })
      .filter(function (r) { return typeof r === 'number' && r >= 1 && r <= 5; });
    var avgRating = null;
    if (ratings.length) {
      var sum = ratings.reduce(function (a, b) { return a + b; }, 0);
      avgRating = Math.round((sum / ratings.length) * 10) / 10;
    }
    return { count: list.length, lastDate: lastDate, avgRating: avgRating };
  }


  // ---- multi-photo import -----------------------------------------------
  // Builds the ONE request that sends several photos of the same recipe, or an
  // error the caller can show without touching the network.
  function buildMultiImageRequest(items, addedBy) {
    var list = (Array.isArray(items) ? items : []).filter(function (it) {
      return it && typeof it.imageBase64 === 'string' && it.imageBase64 && it.mimeType;
    });
    if (!list.length) return { error: 'No photos to send' };
    if (list.length > 3) return { error: 'At most 3 photos can be combined into one recipe' };
    var total = list.reduce(function (n, it) { return n + it.imageBase64.length; }, 0);
    if (total > 3500000) return { error: 'Those photos are too large together' };
    return {
      path: '/api/process',
      body: {
        images: list.map(function (it) { return { imageBase64: it.imageBase64, mimeType: it.mimeType }; }),
        addedBy: addedBy || '',
      },
    };
  }

  root.RCUtils = {
    parseIngredientLine: parseIngredientLine,
    formatQty: formatQty,
    classifyAisle: classifyAisle,
    mergeShoppingItems: mergeShoppingItems,
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
    matchRecipesToPantry: matchRecipesToPantry,
    cookStats: cookStats,
    buildMultiImageRequest: buildMultiImageRequest,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
