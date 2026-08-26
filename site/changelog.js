(function(){
  const ROOT = document.getElementById('changelog-root');
  const INDEX = document.getElementById('release-index');
  // The changelog JSON lives at data/changelog.json in the repository root and is
  // not duplicated inside site/. Depending on which directory is served as the web
  // root, that file is one of the paths below, so try them in order.
  const JSON_PATHS = ['data/changelog.json', '../data/changelog.json'];

  function fetchFirst(paths){
    if(!paths.length) return Promise.reject(new Error('No changelog path resolved'));
    return fetch(paths[0]).then(r=>{
      if(!r.ok) throw new Error('Fetch failed: '+r.status);
      return r.json();
    }).catch(err=>{
      if(paths.length > 1) return fetchFirst(paths.slice(1));
      throw err;
    });
  }

  function el(tag, attrs, children){
    const e = document.createElement(tag);
    if(attrs){
      Object.keys(attrs).forEach(k=>{
        if(k.startsWith('on') && typeof attrs[k]==='function') e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      });
    }
    (children||[]).forEach(c=> e.append(typeof c==='string' ? document.createTextNode(c) : c));
    return e;
  }

  // Slug helper: turns a version (or date) into a stable, URL-safe id fragment.
  // Same rule as the one duplicated in site/presets/index.html and
  // site/plugins/flagship.html: lowercase, non-alphanumerics to '-', trimmed.
  // Keep the copies in sync — there is no build step.
  function slugify(s){
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Stable per-entry id: 'release-<version-slug>', falling back to the date and
  // then to 'entry-<n>'. Duplicate slugs get -2/-3 suffixes, in file order after
  // the newest-first sort, so ids stay unique on the page.
  const seenIds = {};
  function entryId(item, index){
    const base = slugify(item.version) || slugify(item.date) || ('entry-' + (index + 1));
    const prefix = (slugify(item.version) || slugify(item.date)) ? 'release-' : '';
    const id = prefix + base;
    seenIds[id] = (seenIds[id] || 0) + 1;
    return seenIds[id] > 1 ? id + '-' + seenIds[id] : id;
  }

  function renderEntry(item, index){
    const container = el('article',{class:'entry'});
    container.id = entryId(item, index);
    const meta = el('div',{class:'meta'},[
      `${item.version || 'Unversioned'} — ${item.date || 'Unknown date'}`
    ]);
    const title = el('h2',null,[item.title || (item.version ? 'Release '+item.version : 'Change')]);
    const notes = el('div',null,[]);
    if(Array.isArray(item.notes)){
      const ul = el('ul',null,item.notes.map(n=>el('li',null,[n])));
      notes.appendChild(ul);
    } else if(item.notes){
      notes.appendChild(el('p',null,[item.notes]));
    }

    container.appendChild(meta);
    container.appendChild(title);
    container.appendChild(notes);

    if(item.links && typeof item.links==='object'){
      const linkList = el('p',null,[]);
      Object.keys(item.links).forEach(k=>{
        const href = item.links[k];
        const a = el('a',{href:href},[k]);
        linkList.appendChild(a);
        linkList.appendChild(document.createTextNode(' '));
      });
      container.appendChild(linkList);
    }

    // '#' permalink, mirroring .preset-permalink in the presets gallery.
    const label = item.version ? ('release ' + item.version) : (item.title || 'this entry');
    container.appendChild(el('a',{
      class:'permalink',
      href:'#' + container.id,
      'aria-label':'Permalink to ' + label
    },['#']));

    return container;
  }

  // Short label for the release index: "version — date", falling back to the
  // entry title and then to 'Unversioned', so an entry with neither a version
  // nor a date still gets something readable to click on.
  function indexLabel(item){
    const name = item.version || item.title || 'Unversioned';
    return item.date ? (name + ' — ' + item.date) : name;
  }

  // Build the jump list above the entries. `rendered` carries the ids that were
  // actually assigned to the <article class="entry"> nodes: entryId() keeps
  // state in seenIds, so recomputing here would invent -2 suffixes that match
  // nothing on the page. Reuse, never recompute.
  function buildIndex(rendered){
    if(!INDEX) return;
    INDEX.innerHTML = '';
    if(rendered.length < 2){
      INDEX.hidden = true;
      return;
    }
    const list = el('ul',{class:'release-index-list'},[]);
    rendered.forEach(entry=>{
      const a = el('a',{href:'#' + entry.id, 'data-target':entry.id},[indexLabel(entry.item)]);
      list.appendChild(el('li',null,[a]));
    });
    INDEX.appendChild(el('h2',{class:'release-index-title'},['Releases']));
    INDEX.appendChild(list);
    INDEX.hidden = false;
  }

  // Mark the index link whose entry the URL currently points at.
  function highlightIndex(id){
    if(!INDEX || INDEX.hidden) return;
    const links = INDEX.querySelectorAll('a[data-target]');
    for(let i=0;i<links.length;i++){
      const link = links[i];
      if(id && link.getAttribute('data-target') === id){
        link.classList.add('current');
        link.setAttribute('aria-current','true');
      } else {
        link.classList.remove('current');
        link.removeAttribute('aria-current');
      }
    }
  }

  // Deep links: when the URL carries #release-<slug>, scroll that entry into
  // view once the list has been rendered, and again on every hash change.
  // Same pattern as applyHash() in site/presets/index.html.
  function applyHash(){
    const id = (location.hash || '').replace(/^#/, '');
    const target = id ? document.getElementById(id) : null;
    const isEntry = !!(target && target.classList && target.classList.contains('entry'));
    highlightIndex(isEntry ? id : '');
    if(!isEntry) return;
    if(typeof target.scrollIntoView === 'function') target.scrollIntoView();
  }

  function showError(msg){
    if(INDEX){ INDEX.innerHTML = ''; INDEX.hidden = true; }
    ROOT.innerHTML = '';
    const p = document.createElement('p'); p.className='loading'; p.textContent = msg;
    ROOT.appendChild(p);
  }

  function parseDate(item){
    const t = item && typeof item.date === 'string' ? Date.parse(item.date) : NaN;
    return Number.isNaN(t) ? null : t;
  }

  // Sort entries newest-first by item.date (YYYY-MM-DD), independent of the
  // order they happen to appear in data/changelog.json. Entries with a
  // missing or unparseable date sink to the bottom but keep their original
  // relative order (and each other's), so a bad date never throws or hides
  // an entry — it just can't be dated with confidence.
  function sortNewestFirst(items){
    return items
      .map((item, index) => ({ item, index, time: parseDate(item) }))
      .sort((a, b) => {
        if(a.time === null && b.time === null) return a.index - b.index;
        if(a.time === null) return 1;
        if(b.time === null) return -1;
        if(b.time !== a.time) return b.time - a.time;
        return a.index - b.index;
      })
      .map(entry => entry.item);
  }

  fetchFirst(JSON_PATHS).then(data=>{
    ROOT.innerHTML='';
    const list = Array.isArray(data) ? data : (data.entries || []);
    if(list.length===0){
      showError('No changelog entries found.');
      return;
    }
    const rendered = [];
    sortNewestFirst(list).forEach((item, index)=>{
      const node = renderEntry(item, index);
      ROOT.appendChild(node);
      // Keep the id the article actually got — see buildIndex().
      rendered.push({id:node.id, item:item});
    });
    buildIndex(rendered);
    applyHash();
    window.addEventListener('hashchange', applyHash);
  }).catch(err=>{
    showError('Unable to load changelog. See console for details.');
    console.error(err);
  });
})();