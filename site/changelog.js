(function(){
  const ROOT = document.getElementById('changelog-root');
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

  function renderEntry(item){
    const container = el('article',{class:'entry'});
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

    return container;
  }

  function showError(msg){
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
    sortNewestFirst(list).forEach(item=>{
      ROOT.appendChild(renderEntry(item));
    });
  }).catch(err=>{
    showError('Unable to load changelog. See console for details.');
    console.error(err);
  });
})();