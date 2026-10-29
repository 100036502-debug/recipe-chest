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

  root.RCUtils = {
    parseIngredientLine: parseIngredientLine,
    formatQty: formatQty,
    normalizeIngredientName: normalizeIngredientName,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
