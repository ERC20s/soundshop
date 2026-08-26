/*!
 * SOUNDSHOP — preset gallery
 * "Instruments for the deep end."
 *
 * Drives site/presets/index.html: loads the VANTA preset library named by the
 * gallery container's data-src attribute, renders the cards, runs the search /
 * filter / sort controls, mirrors the state into the URL hash, and auditions a
 * preset through window.SSSynth.
 *
 * No modules, no build step, no network beyond the one same-directory JSON
 * file. Every node is built with createElement/textContent — nothing fetched
 * is ever assigned to innerHTML. If the container is absent the file does
 * nothing at all, so it is safe to include anywhere.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var SS = global.SS || {};

  /* ------------------------------------------------------------------ *
   * Small helpers (used instead of SS.* so the file stands on its own)
   * ------------------------------------------------------------------ */

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function fold(value) {
    return String(value === undefined || value === null ? '' : value).toLowerCase();
  }

  function toast(message) {
    if (typeof SS.toast === 'function') { SS.toast(message); return; }
    /* Silent fallback: the design system's toast is optional. */
  }

  /* ------------------------------------------------------------------ *
   * Canon
   * ------------------------------------------------------------------ */

  var CATEGORY_ORDER = ['Bass', 'Lead', 'Pad', 'Keys', 'Pluck', 'Texture', 'Arp', 'FX'];

  var GROUP_LABELS = {
    osc: 'Oscillators',
    filter: 'Filter',
    feg: 'Filter Envelope',
    amp: 'Amp Envelope',
    lfo: 'LFO',
    fx: 'Effects',
    arp: 'Arpeggiator',
    master: 'Master'
  };

  /* Audition phrases, in milliseconds from the moment the phrase starts.
     n = MIDI note, t = start, d = held length, v = velocity. Each one is
     written for what the category is actually for: a riff for a bass, a
     spread voicing for a pad, a held chord for an arp so the engine's own
     arpeggiator plays the part. */
  var PHRASES = {
    Bass: [
      { n: 36, t: 0, d: 540, v: 0.98 },
      { n: 36, t: 640, d: 250, v: 0.8 },
      { n: 48, t: 950, d: 250, v: 0.72 },
      { n: 39, t: 1260, d: 640, v: 0.92 },
      { n: 36, t: 2000, d: 1000, v: 0.95 }
    ],
    Lead: [
      { n: 72, t: 0, d: 330, v: 0.9 },
      { n: 74, t: 300, d: 300, v: 0.86 },
      { n: 79, t: 610, d: 430, v: 0.95 },
      { n: 77, t: 1000, d: 300, v: 0.86 },
      { n: 74, t: 1300, d: 1500, v: 0.9 }
    ],
    Pad: [
      { n: 45, t: 0, d: 2900, v: 0.8 },
      { n: 52, t: 60, d: 2860, v: 0.78 },
      { n: 60, t: 120, d: 2800, v: 0.76 },
      { n: 64, t: 180, d: 2760, v: 0.74 },
      { n: 67, t: 240, d: 2720, v: 0.72 }
    ],
    Keys: [
      { n: 45, t: 0, d: 2400, v: 0.85 },
      { n: 52, t: 45, d: 2360, v: 0.8 },
      { n: 60, t: 90, d: 2320, v: 0.78 },
      { n: 64, t: 135, d: 2280, v: 0.76 },
      { n: 67, t: 180, d: 2240, v: 0.74 }
    ],
    Pluck: [
      { n: 67, t: 0, d: 380, v: 0.92 },
      { n: 72, t: 150, d: 380, v: 0.86 },
      { n: 74, t: 300, d: 380, v: 0.86 },
      { n: 79, t: 450, d: 460, v: 0.95 },
      { n: 76, t: 640, d: 380, v: 0.84 },
      { n: 72, t: 790, d: 900, v: 0.82 }
    ],
    Texture: [
      { n: 36, t: 0, d: 3400, v: 0.8 },
      { n: 43, t: 220, d: 3200, v: 0.74 },
      { n: 50, t: 440, d: 3000, v: 0.7 }
    ],
    Arp: [
      { n: 45, t: 0, d: 3600, v: 0.9 },
      { n: 52, t: 0, d: 3600, v: 0.86 },
      { n: 57, t: 0, d: 3600, v: 0.84 },
      { n: 60, t: 0, d: 3600, v: 0.82 }
    ],
    FX: [
      { n: 36, t: 0, d: 1300, v: 0.9 },
      { n: 48, t: 1200, d: 2200, v: 0.85 }
    ]
  };

  var FALLBACK_PHRASE = PHRASES.Keys;

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  var refs = { resets: [] };
  var presets = [];
  var view = [];
  var paramMeta = {};        /* name -> { label, unit, group, type } */
  var groupOrder = [];
  var cardsById = {};

  var state = { q: '', cat: 'All', sort: 'name' };

  var searchTimer = 0;
  var hashTimer = 0;
  var suppressHash = false;

  /* Audition */
  var Synth = null;
  var audioAvailable = false;
  var playing = null;        /* preset id currently auditioning */
  var playToken = 0;
  var timers = [];

  /* ------------------------------------------------------------------ *
   * Audition engine
   * ------------------------------------------------------------------ */

  function clearTimers() {
    for (var i = 0; i < timers.length; i++) global.clearTimeout(timers[i]);
    timers.length = 0;
  }

  function setPlayingCard(id, on) {
    var card = cardsById[id];
    if (!card) return;
    card.root.classList.toggle('is-playing', !!on);
    if (card.btn) {
      card.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      card.btn.classList.toggle('is-active', !!on);
      if (card.btnLabel) card.btnLabel.textContent = on ? 'Playing' : 'Audition';
    }
  }

  function stopAudition(hard) {
    playToken++;
    clearTimers();
    if (playing) {
      setPlayingCard(playing, false);
      playing = null;
    }
    if (hard !== false && Synth && Synth.ready) {
      try { Synth.panic(); } catch (e) { /* never break the page for audio */ }
    }
    if (refs.stop) refs.stop.disabled = true;
  }

  function schedulePhrase(preset, token) {
    var phrase = PHRASES[preset.category] || FALLBACK_PHRASE;
    var end = 0;
    var i;

    for (i = 0; i < phrase.length; i++) {
      (function (step) {
        timers.push(global.setTimeout(function () {
          if (token !== playToken) return;
          try { Synth.noteOn(step.n, step.v); } catch (e) {}
        }, step.t));
        timers.push(global.setTimeout(function () {
          if (token !== playToken) return;
          try { Synth.noteOff(step.n); } catch (e) {}
        }, step.t + step.d));
      })(phrase[i]);
      end = Math.max(end, phrase[i].t + phrase[i].d);
    }

    /* Let the release tail ring; only the "playing" state ends here. */
    timers.push(global.setTimeout(function () {
      if (token !== playToken) return;
      if (playing === preset.id) {
        setPlayingCard(preset.id, false);
        playing = null;
        if (refs.stop) refs.stop.disabled = true;
      }
    }, end + 420));
  }

  function audition(preset) {
    if (!audioAvailable || !Synth) {
      toast('Web Audio is unavailable in this browser.');
      return;
    }
    if (playing === preset.id) { stopAudition(); return; }

    stopAudition();
    var token = ++playToken;

    setPlayingCard(preset.id, true);
    playing = preset.id;
    if (refs.stop) refs.stop.disabled = false;

    Synth.start().then(function (ok) {
      if (token !== playToken) return;
      if (!ok) {
        stopAudition(false);
        toast('The browser refused to start audio.');
        return;
      }
      try {
        Synth.panic();
        Synth.loadPreset(preset.params);
      } catch (e) {
        stopAudition(false);
        toast('That preset could not be loaded.');
        return;
      }
      schedulePhrase(preset, token);
    })['catch'](function () {
      if (token !== playToken) return;
      stopAudition(false);
      toast('The browser refused to start audio.');
    });
  }

  /* ------------------------------------------------------------------ *
   * Parameter metadata (from the engine, when it is present)
   * ------------------------------------------------------------------ */

  function buildParamMeta() {
    paramMeta = {};
    groupOrder = [];
    if (!Synth || !Synth.PARAM_SPEC) return;
    for (var i = 0; i < Synth.PARAM_SPEC.length; i++) {
      var spec = Synth.PARAM_SPEC[i];
      paramMeta[spec.name] = spec;
      if (groupOrder.indexOf(spec.group) < 0) groupOrder.push(spec.group);
    }
  }

  function formatValue(name, value) {
    var spec = paramMeta[name];
    if (typeof value === 'string') {
      if (spec && spec.options && spec.optionLabels) {
        var idx = spec.options.indexOf(value);
        if (idx >= 0 && spec.optionLabels[idx]) return spec.optionLabels[idx];
      }
      return value;
    }
    var out = String(value);
    if (spec && spec.unit) out += ' ' + spec.unit;
    return out;
  }

  function paramLabel(name) {
    var spec = paramMeta[name];
    return spec && spec.label ? spec.label : name;
  }

  /* ------------------------------------------------------------------ *
   * Card rendering
   * ------------------------------------------------------------------ */

  function buildParamList(preset) {
    var list = el('dl', 'spec preset-params');
    var names = Object.keys(preset.params);
    var used = {};
    var g, i;

    function row(name) {
      var rowEl = el('div', 'spec__row');
      var dt = el('dt', 'spec__key', paramLabel(name));
      var dd = el('dd', 'spec__val num', formatValue(name, preset.params[name]));
      rowEl.appendChild(dt);
      rowEl.appendChild(dd);
      list.appendChild(rowEl);
      used[name] = true;
    }

    for (g = 0; g < groupOrder.length; g++) {
      var group = groupOrder[g];
      var members = [];
      for (i = 0; i < names.length; i++) {
        var meta = paramMeta[names[i]];
        if (meta && meta.group === group) members.push(names[i]);
      }
      if (!members.length) continue;
      list.appendChild(el('div', 'spec__group', GROUP_LABELS[group] || group));
      for (i = 0; i < members.length; i++) row(members[i]);
    }

    for (i = 0; i < names.length; i++) {
      if (!used[names[i]]) row(names[i]);
    }

    return list;
  }

  function buildCard(preset) {
    var card = el('article', 'card card--preset');
    card.setAttribute('data-preset-id', preset.id);
    card.id = 'preset-' + preset.id;

    var body = el('div', 'card__body');

    /* Head: name + category */
    var head = el('div', 'preset-card__head');
    var title = el('h3', 'card__title', preset.name);
    var badge = el('span', 'badge badge--cat', preset.category);
    head.appendChild(title);
    head.appendChild(badge);
    body.appendChild(head);

    var byline = el('p', 'preset-card__by');
    byline.appendChild(el('span', 'label', 'By'));
    byline.appendChild(doc.createTextNode(' '));
    byline.appendChild(el('span', 'preset-card__author', preset.author));
    body.appendChild(byline);

    body.appendChild(el('p', 'card__sub', preset.description));

    /* Tags */
    if (preset.tags && preset.tags.length) {
      var tags = el('div', 'preset__tags');
      for (var t = 0; t < preset.tags.length; t++) {
        (function (tagValue) {
          var chip = el('button', 'tag tag--sm');
          chip.type = 'button';
          chip.textContent = tagValue;
          chip.title = 'Search for "' + tagValue + '"';
          chip.addEventListener('click', function () {
            setState({ q: tagValue }, true);
            if (refs.search) refs.search.value = tagValue;
          });
          tags.appendChild(chip);
        })(preset.tags[t]);
      }
      body.appendChild(tags);
    }

    /* Params */
    var details = el('details', 'accordion__item preset-card__params');
    var summary = el('summary', 'accordion__summary');
    summary.appendChild(el('span', null, 'Parameters'));
    summary.appendChild(el('span', 'num muted', String(Object.keys(preset.params).length)));
    details.appendChild(summary);
    var pbody = el('div', 'accordion__body');
    pbody.appendChild(buildParamList(preset));
    details.appendChild(pbody);
    body.appendChild(details);

    /* Actions */
    var actions = el('div', 'cluster cluster--sm preset-card__actions');

    var play = el('button', 'btn btn--sm btn-primary preset-card__play');
    play.type = 'button';
    play.setAttribute('aria-pressed', 'false');
    var glyph = el('span', 'preset-card__glyph');
    glyph.setAttribute('aria-hidden', 'true');
    var playLabel = el('span', null, 'Audition');
    play.appendChild(glyph);
    play.appendChild(playLabel);
    play.addEventListener('click', function () { audition(preset); });
    if (!audioAvailable) {
      play.disabled = true;
      play.title = 'Web Audio is unavailable in this browser.';
    }
    actions.appendChild(play);

    var copy = el('button', 'btn btn--sm btn-ghost');
    copy.type = 'button';
    copy.textContent = 'Copy params JSON';
    copy.addEventListener('click', function () {
      var payload = JSON.stringify({
        name: preset.name,
        author: preset.author,
        category: preset.category,
        params: preset.params
      }, null, 2);
      if (typeof SS.copyText === 'function') {
        SS.copyText(payload).then(function (ok) {
          toast(ok ? preset.name + ' copied as JSON' : 'Copy failed — select the parameters instead');
        });
      } else {
        toast('Clipboard unavailable in this browser.');
      }
    });
    actions.appendChild(copy);

    body.appendChild(actions);
    card.appendChild(body);

    cardsById[preset.id] = { root: card, btn: play, btnLabel: playLabel };
    return card;
  }

  /* ------------------------------------------------------------------ *
   * Filtering, sorting, rendering
   * ------------------------------------------------------------------ */

  function haystack(preset) {
    if (preset._hay) return preset._hay;
    preset._hay = [
      fold(preset.name), fold(preset.author), fold(preset.category),
      fold(preset.description), fold(preset.id), fold((preset.tags || []).join(' '))
    ].join(' \u0000 ');
    return preset._hay;
  }

  function matches(preset, terms) {
    var hay = haystack(preset);
    for (var i = 0; i < terms.length; i++) {
      if (hay.indexOf(terms[i]) < 0) return false;
    }
    return true;
  }

  function compare(a, b) {
    if (state.sort === 'category') {
      var ai = CATEGORY_ORDER.indexOf(a.category);
      var bi = CATEGORY_ORDER.indexOf(b.category);
      if (ai < 0) ai = CATEGORY_ORDER.length;
      if (bi < 0) bi = CATEGORY_ORDER.length;
      if (ai !== bi) return ai - bi;
    } else if (state.sort === 'author') {
      var byAuthor = a.author.localeCompare(b.author);
      if (byAuthor !== 0) return byAuthor;
    }
    return a.name.localeCompare(b.name);
  }

  function computeView() {
    var terms = state.q.split(/\s+/).map(fold).filter(function (t) { return t.length > 0; });
    view = presets.filter(function (p) {
      if (state.cat !== 'All' && p.category !== state.cat) return false;
      if (terms.length && !matches(p, terms)) return false;
      return true;
    });
    view.sort(compare);
  }

  function renderCategories() {
    if (!refs.cats) return;
    clear(refs.cats);

    var counts = {};
    var i;
    for (i = 0; i < presets.length; i++) {
      counts[presets[i].category] = (counts[presets[i].category] || 0) + 1;
    }

    var list = ['All'];
    for (i = 0; i < CATEGORY_ORDER.length; i++) {
      if (counts[CATEGORY_ORDER[i]]) list.push(CATEGORY_ORDER[i]);
    }
    for (i = 0; i < presets.length; i++) {
      if (list.indexOf(presets[i].category) < 0) list.push(presets[i].category);
    }

    for (i = 0; i < list.length; i++) {
      (function (name) {
        var btn = el('button', 'tag');
        btn.type = 'button';
        btn.appendChild(el('span', null, name));
        btn.appendChild(el('span', 'tag__count num',
          String(name === 'All' ? presets.length : (counts[name] || 0))));
        btn.setAttribute('aria-pressed', state.cat === name ? 'true' : 'false');
        btn.addEventListener('click', function () { setState({ cat: name }, true); });
        refs.cats.appendChild(btn);
      })(list[i]);
    }
  }

  function syncCategoryPressed() {
    if (!refs.cats) return;
    var buttons = refs.cats.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var name = buttons[i].firstChild ? buttons[i].firstChild.textContent : '';
      buttons[i].setAttribute('aria-pressed', name === state.cat ? 'true' : 'false');
    }
  }

  function renderGrid() {
    if (!refs.grid) return;

    /* Anything still sounding belongs to a card that is about to be replaced. */
    if (playing) stopAudition();

    clear(refs.grid);
    cardsById = {};

    var frag = doc.createDocumentFragment();
    for (var i = 0; i < view.length; i++) frag.appendChild(buildCard(view[i]));
    refs.grid.appendChild(frag);

    if (refs.empty) refs.empty.hidden = view.length !== 0;
    refs.grid.hidden = view.length === 0;

    if (refs.count) {
      refs.count.textContent = view.length === presets.length
        ? 'Showing all ' + presets.length + ' presets'
        : 'Showing ' + view.length + ' of ' + presets.length + ' presets';
    }

    var filtered = state.q !== '' || state.cat !== 'All' || state.sort !== 'name';
    for (var r = 0; r < refs.resets.length; r++) refs.resets[r].hidden = !filtered;
  }

  function render() {
    computeView();
    syncCategoryPressed();
    renderGrid();
  }

  /* ------------------------------------------------------------------ *
   * URL hash — reflect the state without pushing history entries
   * ------------------------------------------------------------------ */

  function writeHash() {
    if (!global.history || !global.history.replaceState) return;
    var parts = [];
    if (state.cat !== 'All') parts.push('cat=' + encodeURIComponent(state.cat));
    if (state.q !== '') parts.push('q=' + encodeURIComponent(state.q));
    if (state.sort !== 'name') parts.push('sort=' + encodeURIComponent(state.sort));

    var current = global.location.hash || '';
    var hash = parts.length ? '#' + parts.join('&') : '';

    /* A plain "#preset-name" anchor from another page is not ours to erase. */
    if (!parts.length && current && current.indexOf('=') < 0) return;
    if (current === hash) return;

    var url = global.location.pathname + global.location.search + hash;

    suppressHash = true;
    try { global.history.replaceState(null, '', url); } catch (e) {}
    global.setTimeout(function () { suppressHash = false; }, 0);
  }

  function readHash() {
    var raw = (global.location.hash || '').replace(/^#/, '');
    var next = { q: '', cat: 'All', sort: 'name' };
    if (!raw) return next;

    var pairs = raw.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var eq = pairs[i].indexOf('=');
      if (eq < 0) continue;
      var key = pairs[i].slice(0, eq);
      var value = pairs[i].slice(eq + 1);
      try { value = decodeURIComponent(value.replace(/\+/g, ' ')); } catch (e) {}
      if (key === 'q') next.q = value;
      else if (key === 'cat') next.cat = value;
      else if (key === 'sort') next.sort = value;
    }

    if (next.cat !== 'All' && CATEGORY_ORDER.indexOf(next.cat) < 0) {
      var found = 'All';
      for (var c = 0; c < CATEGORY_ORDER.length; c++) {
        if (fold(CATEGORY_ORDER[c]) === fold(next.cat)) found = CATEGORY_ORDER[c];
      }
      next.cat = found;
    }
    if (next.sort !== 'name' && next.sort !== 'category' && next.sort !== 'author') next.sort = 'name';
    return next;
  }

  function syncControls() {
    if (refs.search && refs.search.value !== state.q) refs.search.value = state.q;
    if (refs.sort && refs.sort.value !== state.sort) refs.sort.value = state.sort;
  }

  function setState(patch, updateHash) {
    var changed = false;
    for (var key in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      if (state[key] !== patch[key]) { state[key] = patch[key]; changed = true; }
    }
    if (!changed) return;
    syncControls();
    render();
    if (updateHash !== false) {
      global.clearTimeout(hashTimer);
      hashTimer = global.setTimeout(writeHash, 180);
    }
  }

  /* ------------------------------------------------------------------ *
   * Controls
   * ------------------------------------------------------------------ */

  function wireControls() {
    if (refs.search) {
      refs.search.addEventListener('input', function () {
        var value = refs.search.value;
        global.clearTimeout(searchTimer);
        searchTimer = global.setTimeout(function () { setState({ q: value }); }, 160);
      });
      refs.search.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && refs.search.value !== '') {
          event.preventDefault();
          refs.search.value = '';
          setState({ q: '' });
        }
      });
    }

    if (refs.sort) {
      refs.sort.addEventListener('change', function () {
        setState({ sort: refs.sort.value });
      });
    }

    for (var r = 0; r < refs.resets.length; r++) {
      refs.resets[r].addEventListener('click', function () {
        if (refs.search) refs.search.value = '';
        setState({ q: '', cat: 'All', sort: 'name' });
        if (refs.search) refs.search.focus();
      });
    }

    if (refs.stop) {
      refs.stop.disabled = true;
      refs.stop.addEventListener('click', function () { stopAudition(); });
    }

    global.addEventListener('hashchange', function () {
      if (suppressHash) return;
      var next = readHash();
      setState(next, false);
    });

    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden && playing) stopAudition();
    });
    global.addEventListener('pagehide', function () { stopAudition(); });

    doc.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !playing) return;
      var active = doc.activeElement;
      if (active && active === refs.search) return;
      stopAudition();
    });
  }

  /* ------------------------------------------------------------------ *
   * Load
   * ------------------------------------------------------------------ */

  function showError(title, message, detail) {
    if (!refs.error) return;
    clear(refs.error);
    refs.error.appendChild(el('p', 'note__title', title));
    refs.error.appendChild(el('p', null, message));
    if (detail) refs.error.appendChild(el('p', 'muted preset-error__detail', detail));
    refs.error.hidden = false;
    if (refs.status) refs.status.hidden = true;
    if (refs.grid) refs.grid.hidden = true;
    if (refs.empty) refs.empty.hidden = true;
    if (refs.count) refs.count.textContent = 'The preset library could not be loaded.';
    if (refs.toolbar) refs.toolbar.hidden = true;
  }

  function isValidPreset(entry) {
    return entry && typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      typeof entry.name === 'string' &&
      typeof entry.author === 'string' &&
      typeof entry.category === 'string' &&
      entry.params && typeof entry.params === 'object';
  }

  function ingest(data) {
    var raw = Array.isArray(data) ? data : (data && Array.isArray(data.presets) ? data.presets : null);
    if (!raw) {
      showError('Malformed library',
        'The preset file loaded but is not a list of presets.',
        'Expected a JSON array of preset objects.');
      return;
    }

    presets = raw.filter(isValidPreset).map(function (entry) {
      return {
        id: entry.id,
        name: entry.name,
        author: entry.author,
        category: entry.category,
        tags: Array.isArray(entry.tags) ? entry.tags.filter(function (t) { return typeof t === 'string'; }) : [],
        description: typeof entry.description === 'string' ? entry.description : '',
        params: entry.params
      };
    });

    if (!presets.length) {
      showError('Empty library',
        'The preset file loaded but contained no usable presets.',
        null);
      return;
    }

    if (refs.status) refs.status.hidden = true;
    if (refs.toolbar) refs.toolbar.hidden = false;
    if (refs.total) refs.total.textContent = String(presets.length);
    if (refs.totalCats) {
      var cats = {};
      for (var i = 0; i < presets.length; i++) cats[presets[i].category] = true;
      refs.totalCats.textContent = String(Object.keys(cats).length);
    }
    if (refs.totalAuthors) {
      var authors = {};
      for (var a = 0; a < presets.length; a++) authors[presets[a].author] = true;
      refs.totalAuthors.textContent = String(Object.keys(authors).length);
    }

    state = readHash();
    syncControls();
    renderCategories();
    render();
    writeHash();
    scrollToAnchor();
  }

  /* The cards only exist once the library has rendered, so a "#preset-id"
     link from another page has to be honoured here rather than by the
     browser's own load-time jump. */
  function scrollToAnchor() {
    var raw = (global.location.hash || '').replace(/^#/, '');
    if (!raw || raw.indexOf('=') >= 0) return;
    if (typeof doc.getElementById !== 'function') return;
    var target = doc.getElementById(raw);
    if (!target || typeof target.scrollIntoView !== 'function') return;
    try {
      target.scrollIntoView({ block: 'start' });
    } catch (e) {
      target.scrollIntoView();
    }
  }

  function load(src) {
    if (!global.fetch) {
      showError('This browser cannot load the library',
        'The preset gallery needs the Fetch API to read its data file.',
        null);
      return;
    }

    global.fetch(src, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(ingest)['catch'](function (err) {
      var fileProtocol = global.location && global.location.protocol === 'file:';
      if (fileProtocol) {
        showError('Opened from the filesystem',
          'Browsers refuse to read a JSON file from a file:// page, so the library cannot be listed here. Serve this folder over HTTP and the gallery works offline as normal.',
          'Any static server will do — the site has no build step and no external dependencies.');
      } else {
        showError('The preset library did not load',
          'The data file could not be read. Reload the page; if it keeps failing the file may be missing from this deployment.',
          err && err.message ? String(err.message) : null);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function init() {
    var root = doc.querySelector('[data-preset-gallery]');
    if (!root) return;   /* safe to include on any page */

    refs = {
      root: root,
      grid: root.querySelector('[data-preset-grid]'),
      empty: root.querySelector('[data-preset-empty]'),
      error: root.querySelector('[data-preset-error]'),
      status: root.querySelector('[data-preset-status]'),
      toolbar: root.querySelector('[data-preset-toolbar]'),
      cats: root.querySelector('[data-preset-cats]'),
      search: root.querySelector('[data-preset-search]'),
      sort: root.querySelector('[data-preset-sort]'),
      count: root.querySelector('[data-preset-count]'),
      resets: Array.prototype.slice.call(root.querySelectorAll('[data-preset-reset]')),
      stop: root.querySelector('[data-preset-stop]'),
      total: doc.querySelector('[data-preset-total]'),
      totalCats: doc.querySelector('[data-preset-total-cats]'),
      totalAuthors: doc.querySelector('[data-preset-total-authors]')
    };

    Synth = global.SSSynth || null;
    audioAvailable = !!(Synth && Synth.supported);
    buildParamMeta();

    var audioNote = root.querySelector('[data-preset-audio-note]');
    if (audioNote) audioNote.hidden = audioAvailable;

    if (refs.empty) refs.empty.hidden = true;
    if (refs.error) refs.error.hidden = true;

    wireControls();

    var src = root.getAttribute('data-src');
    if (!src) {
      showError('No library configured',
        'This gallery has no data source set, so there is nothing to list.',
        null);
      return;
    }
    load(src);
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* A tiny surface for the rest of the site — nothing else depends on it. */
  global.SSPresets = {
    stop: function () { stopAudition(); return global.SSPresets; },
    getAll: function () { return presets.slice(); },
    getVisible: function () { return view.slice(); }
  };

})(typeof window !== 'undefined' ? window : this);
