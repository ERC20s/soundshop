(function(){
  const ROOT = document.getElementById('changelog-root');
  const JSON_PATH = '../data/changelog.json';

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

  fetch(JSON_PATH).then(r=>{
    if(!r.ok) throw new Error('Fetch failed: '+r.status);
    return r.json();
  }).then(data=>{
    ROOT.innerHTML='';
    const list = Array.isArray(data) ? data : (data.entries || []);
    if(list.length===0){
      showError('No changelog entries found.');
      return;
    }
    list.forEach(item=>{
      ROOT.appendChild(renderEntry(item));
    });
  }).catch(err=>{
    showError('Unable to load changelog. See console for details.');
    console.error(err);
  });
})();