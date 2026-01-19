// API: prefer the real endpoint but tolerate variations (English/Spanish)
const API_URL = "https://backend-0lcs.onrender.com/products";
const API_ORIGIN = new URL(API_URL).origin;
// Auth endpoints
const AUTH_REGISTER = `${API_ORIGIN}/auth/register`;
const AUTH_TOKEN = `${API_ORIGIN}/auth/token`;

// DOM references will be initialized in `init()` to avoid race conditions
let grid = null;
let searchInput = null;
let filterButtons = null;

// auto-refresh configuration (seconds)
const AUTO_REFRESH_SECONDS = 30;
let products = [];
// indica si los productos fueron cargados desde el API remoto o desde el archivo local
let productsSource = 'api';
let currentFilter = "all";
let autoTimer = null;
let countdownTimer = null;
let countdown = AUTO_REFRESH_SECONDS;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// promotions support
let promotions = [];

async function fetchPromotions(){
  const tryUrls = [
    '/promotions',
    '/promociones',
    `${API_ORIGIN}/promotions`,
    `${API_ORIGIN}/promociones`,
    'promotions.json',
    'promotions.json' // fallback to local file in workspace
  ];
  for (const url of tryUrls){
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) continue;
      const data = await res.json();
      // tolerate different payload shapes: array, { promotions: [...] }, { data: [...] }
      let list = [];
      if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.promotions)) list = data.promotions;
      else if (data && Array.isArray(data.data)) list = data.data;

      if (list.length > 0){ promotions = list; return promotions; }
    } catch (err) { /* ignore and try next */ }
  }
  // fallback: try promotions saved by the admin UI in localStorage (same-origin admin)
  try {
    const stored = localStorage.getItem('admin_promotions_v1');
    if (stored) {
      const data = JSON.parse(stored);
      if (Array.isArray(data) && data.length > 0) {
        promotions = data;
        return promotions;
      }
    }
  } catch (err) { /* ignore parsing errors */ }

  promotions = [];
  return promotions;
}

// Listen for admin broadcasts (when admin saves promotions it uses BroadcastChannel 'promo_channel')
try{
  if (typeof BroadcastChannel !== 'undefined'){
    const bc = new BroadcastChannel('promo_channel');
    bc.onmessage = (ev) => {
      try{
        if (!ev.data) return;
        // admin posts { action: 'promotions-updated', promos }
        if (ev.data.action === 'promotions-updated' && Array.isArray(ev.data.promos)){
          promotions = ev.data.promos;
          console.log('[catalogo] promotions updated via BroadcastChannel', promotions);
          // re-render catalog to reflect promotion changes
          try{ render({ animate: true }); }catch(e){}
        }
      }catch(e){/* ignore */}
    };
  }
}catch(e){/* ignore if BroadcastChannel unavailable */}

function getBestPromotionForProduct(product){
  if (!promotions || promotions.length===0) return null;
  // allow passing either a product object or an id/string
  let candidates = [];
  const prodObj = (typeof product === 'object' && product !== null) ? product : null;
  const prodId = prodObj ? (prodObj.id ?? prodObj._id ?? prodObj._id_str ?? prodObj.sku) : product;
  const prodName = prodObj ? (prodObj.nombre || prodObj.name || '') : '';
  const pidStr = prodId !== undefined && prodId !== null ? String(prodId) : null;

  const matches = promotions.filter(pr => {
    if (!pr || !Array.isArray(pr.productIds)) return false;
    return pr.productIds.some(x => {
      if (x === undefined || x === null) return false;
      const xs = String(x);
      if (pidStr && xs === pidStr) return true;
      // also accept numeric equality when possible
      if (pidStr && !Number.isNaN(Number(xs)) && !Number.isNaN(Number(pidStr)) && Number(xs) === Number(pidStr)) return true;
      // allow matching by product name (useful if admin saved names)
      if (prodName && xs.toLowerCase() === prodName.toLowerCase()) return true;
      return false;
    });
  });

  if (!matches.length) return null;
  // prefer the one with highest value (percent/fixed)
  matches.sort((a,b)=> (Number(b.value)||0) - (Number(a.value)||0));
  return matches[0];
}

function getDiscountedPrice(price, promo){
  if (!promo) return price;
  let val = Number(promo.value || 0);
  if (promo.type === 'percent') {
    // Support promotions where `value` is a fraction (0.12) or a percent (12)
    if (val > 0 && val <= 1) {
      return Math.max(0, +(price * (1 - val)).toFixed(2));
    }
    return Math.max(0, +(price * (1 - val / 100)).toFixed(2));
  }
  if (promo.type === 'fixed') return Math.max(0, +(price - val).toFixed(2));
  return price;
}

function normalize(p) {
  // soporta respuesta en español o inglés y normaliza valores
  const name = (p.nombre || p.name || "").trim();
  const description = (p.descripcion || p.description || "").trim();
  const category = (p.categoria || p.category || "").trim();
  const price = p.precio ?? p.price ?? 0;
  let image = p.imagen || p.image || p.image_url || p.imageUrl || null;
  // Si la ruta es relativa (empieza por '/') no anteponer el origen remoto cuando los
  // datos proceden del `products.json` local — así los assets locales se resuelven correctamente
  if (image && image.startsWith('/')) {
    if (productsSource === 'api') {
      image = API_ORIGIN + image;
    } else {
      // mantener ruta relativa para que el servidor local la sirva
      image = image;
    }
  }
  return { ...p, nombre: name, descripcion: description, categoria: category, precio: price, imagen: image };
} 

function showMessage(msg, level = "info") {
  try{
    if (!grid) {
      grid = document.getElementById('catalogGrid') || (function(){ const s = document.createElement('section'); s.id='catalogGrid'; document.body.appendChild(s); return s;} )();
    }
    grid.innerHTML = `<p class="message ${level}" role="status" aria-live="polite">${msg}</p>`;
  }catch(e){ console.error('showMessage failed', e); }
}

function renderSkeleton(count = 6) {
  if (!grid) {
    grid = document.getElementById('catalogGrid') || (function(){ const s = document.createElement('section'); s.id='catalogGrid'; document.body.appendChild(s); return s;} )();
  }
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const card = document.createElement('article');
    card.className = 'product-card skeleton';
    card.innerHTML = `
      <div class="product-image"></div>
      <div class="product-info">
        <h3></h3>
        <p></p>
        <div class="price"></div>
      </div>`;
    frag.appendChild(card);
  }
  grid.appendChild(frag);

  // Post-render defensive step: ensure images aren't hidden by inline styles or late CSS
  try{
    const imgs = document.querySelectorAll('#catalogGrid img, .promotions-row img');
    imgs.forEach(img => {
      try{
        img.style.opacity = '1';
        img.style.visibility = 'visible';
        img.style.display = 'block';
        img.style.transform = 'none';
      }catch(e){}
    });
  }catch(e){/* ignore */}

  // Wire promotion card buttons (filter to promo products when clicked)
  try{
    document.querySelectorAll('.promotion-card .promo-view').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const pid = btn.getAttribute('data-pid');
        const promo = promotions.find(p => String(p.id) === String(pid));
        if (!promo) return;
        // set filter to show only products in this promotion
        const ids = Array.isArray(promo.productIds) ? promo.productIds.map(x => String(x)) : [];
        // narrow products to those matching ids (or names)
        const matched = products.filter(p => ids.includes(String(p.id ?? p._id ?? p.nombre ?? p.name ?? '')) || ids.includes(String(p.nombre || p.name || '')));
        if (matched.length) {
          // temporarily render only matched products
          grid.innerHTML = '';
          const mf = document.createDocumentFragment();
          matched.forEach((p,i) => {
            const card = document.createElement('article');
            card.className = 'product-card';
            card.dataset.pid = String(p.id ?? p._id ?? i);
            card.innerHTML = `
              <div class="product-image">
                <div class="price-badge">$${Number(p.precio || p.price || 0).toFixed(2)}</div>
                <img src="${p.imagen || 'images/placeholder.png'}" alt="${escapeHtml(p.nombre || p.name || '')}" loading="lazy">
              </div>
              <div class="product-info">
                <h3>${escapeHtml(p.nombre || p.name || '')}</h3>
                <p>${escapeHtml(p.descripcion || p.description || '')}</p>
                <div class="price">$${Number(p.precio || p.price || 0).toFixed(2)}</div>
                <div class="card-actions"><button class="btn btn-add" data-id="${String(p.id ?? p._id ?? i)}">Agregar</button></div>
              </div>`;
            mf.appendChild(card);
          });
          grid.appendChild(mf);
        }
      });
    });
  }catch(e){/* ignore promo wiring errors */}
}

async function fetchProducts({ showSkeleton = true } = {}) {
  if (showSkeleton) renderSkeleton();
  // try multiple endpoints: prefer configured remote API when page is served from a different origin
  // (avoid triggering many 404s when the frontend is hosted as static site on another host)
  let tryUrls = [];
  try {
    const pageOrigin = (location && location.protocol && location.protocol.startsWith('http') && location.origin) ? location.origin : null;
    const apiOrigin = (typeof API_URL === 'string' && API_URL) ? (new URL(API_URL)).origin : null;
    if (pageOrigin && apiOrigin && pageOrigin !== apiOrigin) {
      tryUrls = [API_URL, (pageOrigin + '/products'), '/products', 'products.json'];
    } else {
      tryUrls = ['/products', API_URL, 'products.json'];
    }
  } catch (e) {
    tryUrls = ['/products', API_URL, 'products.json'];
  }
  let data = null;
  let used = null;
  for (const url of tryUrls) {
    try {
      const headers = {};
      const token = getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(url, { mode: 'cors', cache: 'no-store', headers });
      if (!res.ok) continue;
      const json = await res.json();
      if (json && (Array.isArray(json) || Array.isArray(json.products) || Array.isArray(json.data))) {
        data = Array.isArray(json) ? json : (json.products || json.data);
        used = url;
        break;
      }
    } catch (err) { /* try next */ }
  }

  if (!data) {
    // try cached copy
    try {
      const cached = localStorage.getItem('catalog:products_cache_v1');
      if (cached) {
        const local = JSON.parse(cached);
        products = local.map(normalize);
        await fetchPromotions();
        render({ animate: true });
        showMessage('Mostrando catálogo desde caché local (offline).', 'info');
        return;
      }
    } catch (cacheErr) { console.warn('cache read failed', cacheErr); }

    showMessage('No se pudieron cargar productos desde el backend. Usando catálogo local si está disponible. ⚠️', 'warning');
    try {
      const local = await (await fetch('products.json')).json();
      productsSource = 'local';
      products = local.map(normalize);
      await fetchPromotions();
      render({ animate: true });
      updateLastUpdated(true);
      return;
    } catch (e) {
      showMessage('No hay productos disponibles', 'error');
      return;
    }
  }

  // success
  productsSource = (used === 'products.json') ? 'local' : 'api';
  products = data.map(normalize);
  try { localStorage.setItem('catalog:products_cache_v1', JSON.stringify(data)); localStorage.setItem('catalog:products_cache_ts', String(Date.now())); } catch (e) { /* ignore */ }
  await fetchPromotions();
  render({ animate: true });
  updateLastUpdated();
}

// visual "fly to cart" effect
function animateFlyToCart(sourceImg){
  try{
    const fab = document.getElementById('cartButton');
    if (!fab || !sourceImg) return;
    const rectSrc = sourceImg.getBoundingClientRect();
    const rectDst = fab.getBoundingClientRect();
    const clone = sourceImg.cloneNode(true);
    clone.classList.add('fly-ghost');
    clone.style.left = `${rectSrc.left}px`;
    clone.style.top = `${rectSrc.top}px`;
    clone.style.width = `${rectSrc.width}px`;
    clone.style.height = `${rectSrc.height}px`;
    clone.style.transition = 'transform 600ms cubic-bezier(.2,.9,.2,1), opacity 600ms ease';
    clone.style.zIndex = 1500;
    clone.style.borderRadius = '8px';
    document.body.appendChild(clone);
    requestAnimationFrame(()=>{
      const dx = rectDst.left + rectDst.width/2 - (rectSrc.left + rectSrc.width/2);
      const dy = rectDst.top + rectDst.height/2 - (rectSrc.top + rectSrc.height/2);
      clone.style.transform = `translate(${dx}px, ${dy}px) scale(.12)`;
      clone.style.opacity = '0.02';
    });
    setTimeout(()=>{ try{ clone.remove(); }catch(_){} }, 600);
  }catch(e){ /* ignore */ }
}

function render({ animate = false } = {}) {
  // defensive: ensure `grid` exists in the DOM. If not, create a visible fallback
  if (!grid) {
    grid = document.getElementById('catalogGrid');
    if (!grid) {
      grid = document.createElement('section');
      grid.id = 'catalogGrid';
      document.body.appendChild(grid);
    }
  }
  grid.style.minHeight = grid.style.minHeight || '200px';
  const search = (searchInput.value || '').toLowerCase();
  const filtered = products.filter(p => {
    const matchesSearch =
      (p.nombre || '').toLowerCase().includes(search) ||
      (p.descripcion || '').toLowerCase().includes(search);
    const matchesFilter =
      currentFilter === "all" || (p.categoria || '').toLowerCase() === currentFilter.toLowerCase();
    return matchesSearch && matchesFilter;
  });

  grid.innerHTML = '';
  // ensure promotions container exists (separate from product grid)
  let promosRow = document.getElementById('promotionsRow');
  if (!promosRow) {
    promosRow = document.createElement('div');
    promosRow.id = 'promotionsRow';
    promosRow.className = 'promotions-row';
    // insert promotions container before the grid to keep products always visible below
    try{
      if (grid.parentNode) grid.parentNode.insertBefore(promosRow, grid);
      else document.body.insertBefore(promosRow, grid);
    }catch(e){ document.body.appendChild(promosRow); }
  }

  if (filtered.length === 0) {
    grid.innerHTML = '<p class="message">No hay resultados</p>';
    promosRow.innerHTML = ''; // clear promos when no results
    return;
  }

  const frag = document.createDocumentFragment();

  // Render simple promotion cards for promotions that apply to the currently filtered products
  // Put promotions into a separate horizontal row so they don't push or hide products on mobile.
  if (Array.isArray(promotions) && promotions.length) {
    const promoFrag = document.createDocumentFragment();
    // clear previous promos container
    promosRow.innerHTML = '';
    const seen = new Set();
    promotions.forEach(pr => {
      try {
        const prIds = Array.isArray(pr.productIds) ? pr.productIds.map(x => String(x)) : [];
        const match = filtered.find(p => {
          const pid = String(p.id ?? p._id ?? p.nombre ?? p.name ?? '');
          if (prIds.length && prIds.includes(pid)) return true;
          // fallback: try matching by product name
          if (prIds.length && prIds.some(x => x.toLowerCase() === String(p.nombre || p.name || '').toLowerCase())) return true;
          return false;
        });
        if (!match || seen.has(pr.id)) return;
        seen.add(pr.id);
        const card = document.createElement('article');
        card.className = 'promotion-card reveal';
        const imgSrc = match.imagen || match.image || 'images/placeholder.png';
        // compute readable promo label: support percent as fraction (0.12) or as whole number (12)
        let promoLabel = 'Oferta';
        try {
          if (pr.type === 'percent') {
            const raw = Number(pr.value || 0);
            const pct = (raw > 0 && raw <= 1) ? Math.round(raw * 100) : Math.round(raw);
            promoLabel = `-${pct}%`;
          } else if (pr.value) {
            promoLabel = `$${Number(pr.value).toFixed(2)}`;
          }
        } catch (e) { promoLabel = 'Oferta'; }
        card.innerHTML = `
          <div class="product-thumb"><img src="${imgSrc}" alt="${escapeHtml(match.nombre || match.name || '')}"></div>
          <div class="product-info">
            <h3 class="product-title">${escapeHtml(pr.name || 'Promoción')}</h3>
            <div class="product-sub">${escapeHtml(pr.description || match.descripcion || '')}</div>
            <div class="price-display">${promoLabel}</div>
            <div class="product-actions"><button class="btn btn-primary promo-view" data-pid="${escapeHtml(String(pr.id))}">Agregar</button></div>
          </div>`;
        promoFrag.appendChild(card);
      } catch (e) { /* ignore individual promo errors */ }
    });
    // append promos into the promotionsRow (separate from product grid)
    promosRow.appendChild(promoFrag);
  }
  filtered.forEach((p, i) => {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.setAttribute('tabindex','0');
    card.setAttribute('role','button');
    card.setAttribute('aria-label', `${p.nombre || 'producto'} — ver imagen`);

    if (animate && !reduceMotion) {
      card.classList.add('reveal');
      card.style.setProperty('--i', i);
      card.setAttribute('data-i', i);
    }

    const imgSrc = p.imagen || 'images/placeholder.png';
    const pid = String(p.id ?? p._id ?? p.nombre ?? i);
    card.dataset.pid = pid;

    // check promotion for this product
    const promo = getBestPromotionForProduct(p);
    const discounted = promo ? getDiscountedPrice(Number(p.precio ?? p.price ?? 0), promo) : null;
    const isNew = p.created_at ? (Date.now() - new Date(p.created_at).getTime()) < (1000 * 60 * 60 * 24 * 7) : false;

    // build promo ribbon label robustly (supports fractional percent values)
    let promoRibbon = '';
    if (promo) {
      try {
        if (promo.type === 'percent') {
          const raw = Number(promo.value || 0);
          const pct = (raw > 0 && raw <= 1) ? Math.round(raw * 100) : Math.round(raw);
          promoRibbon = `-${pct}%`;
        } else if (promo.value) {
          promoRibbon = `$${Number(promo.value).toFixed(2)}`;
        }
      } catch (e) { promoRibbon = '' }
    }

    card.innerHTML = `
      <div class="product-image">
        ${promo && promoRibbon ? `<div class="promo-ribbon">${promoRibbon}</div>` : ''}
        <div class="price-badge">${discounted ? `<span class="price-new">$${Number(discounted).toFixed(2)}</span><span class="price-old">$${Number(p.precio).toFixed(2)}</span>` : `$${Number(p.precio).toFixed(2)}`}</div>
        <img src="${imgSrc}" alt="${escapeHtml(p.nombre)}" loading="lazy" fetchpriority="low">
      </div>
      <div class="product-info">
        <h3>${escapeHtml(p.nombre)} ${isNew ? `<span class="new-badge">Nuevo</span>` : ''}</h3>
        <p>${escapeHtml(p.descripcion)}</p>
        <div class="price">${discounted ? `<span class="price-new">$${Number(discounted).toFixed(2)}</span> <span class="price-old">$${Number(p.precio).toFixed(2)}</span>` : `$${Number(p.precio).toFixed(2)}`}</div>
        <div class="card-actions"><button class="btn btn-add" data-id="${pid}" aria-label="Agregar ${escapeHtml(p.nombre)} al carrito">Agregar</button></div>
      </div>`;
    // post-render image handling: detect aspect ratio, fade-in, error fallback, lightbox trigger
    const temp = document.createElement('div');
    temp.appendChild(card);
    const img = temp.querySelector('img');
    const addBtn = temp.querySelector('.btn-add');

    img.addEventListener('load', () => {
      try {
        const ratio = img.naturalWidth / Math.max(1, img.naturalHeight);
        if (ratio > 1.6) img.classList.add('img--wide');
        else if (ratio < 0.75) img.classList.add('img--tall');
        else img.classList.add('img--square');
      } catch (er) { /* ignore */ }
      img.classList.add('img-loaded');
    });
    img.addEventListener('error', () => {
      try {
        const tries = Number(img.dataset.tryCount || '0');
        img.dataset.tryCount = String(tries + 1);
        // sequence of fallbacks:
        // 1) if image used API_ORIGIN prefix, remove origin -> try relative
        if (tries === 0 && img.src && typeof API_ORIGIN === 'string' && img.src.startsWith(API_ORIGIN) && location.origin !== API_ORIGIN) {
          img.src = img.src.replace(API_ORIGIN, '');
          return;
        }
        // 2) if src starts with leading slash (root-relative), try removing it to load from current folder
        if (tries === 1 && img.src && img.src.startsWith('/')) {
          img.src = img.src.replace(/^\//, '');
          return;
        }
        // 3) try loading from local `uploads/` folder (without leading slash)
        if (tries === 2 && img.src) {
          const name = img.src.split('/').pop();
          if (name) { img.src = `uploads/${name}`; return; }
        }
        // 4) try loading from `images/` fallback
        if (tries === 3) { img.src = `images/${img.getAttribute('alt') ? img.getAttribute('alt').replace(/[^a-z0-9\.\-]/gi,'').toLowerCase()+'.png' : 'placeholder.png'}`; return; }
      } catch (err) { /* ignore */ }
      // final fallback
      img.src = 'images/placeholder.png';
      img.classList.add('img-loaded');
    });

    // stop propagation on Add button and wire add-to-cart (prevents opening lightbox)
    if (addBtn) {
      addBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = addBtn.dataset.id;
        showQuantitySelector(String(id), img || null);
      });
      addBtn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); addBtn.click(); } });
    }

    // accessible interactions: no lightbox on click — emulate lift animation on click/tap
    card.addEventListener('click', (ev) => {
      // ignore clicks originating from interactive controls inside the card
      if (ev.target.closest && ev.target.closest('.btn')) return;
      // card clicks are intentionally inert (no lift effect); keep for accessibility only
      try { card.focus && card.focus(); } catch (_) {}
    });
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); card.click(); } });

    frag.appendChild(card);
  });
  grid.appendChild(frag);

  // if animated, remove reveal class after animation to keep DOM clean
  if (animate && !reduceMotion) {
    const revealed = grid.querySelectorAll('.product-card.reveal');
    revealed.forEach((el) => el.addEventListener('animationend', () => el.classList.remove('reveal'), { once: true }));
  }

  // Wire promotion buttons: add a single promo-summary item to cart
  try {
    document.querySelectorAll('.promotion-card .promo-view').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const pid = btn.getAttribute('data-pid');
        const promo = promotions.find(p => String(p.id) === String(pid));
        if (!promo) return;
        const promoCartId = `promo:${String(promo.id)}`;
        addToCart(promoCartId, 1, null);
        openCart();
      });
    });
  } catch (e) { /* ignore wiring errors */ }
}

/* lightbox: simple, accessible image viewer */
function createLightbox(){
  if (document.getElementById('__catalog_lightbox')) return;
  const overlay = document.createElement('div');
  overlay.id = '__catalog_lightbox';
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `
    <div class="lightbox-inner" role="dialog" aria-modal="true">
      <img alt="" />
      <div class="lightbox-meta">
        <div class="title"></div>
        <div class="desc" style="opacity:.85;margin-top:8px;font-weight:400;font-size:13px"></div>
      </div>
    </div>
    <button class="lightbox-close" aria-label="Cerrar (Esc)">Cerrar</button>`;
  overlay.addEventListener('click', (e)=>{ if (e.target === overlay) closeLightbox(); });
  overlay.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  document.body.appendChild(overlay);
  window.addEventListener('keydown', (ev)=>{ if (ev.key === 'Escape') closeLightbox(); });
}
function openLightbox(src, title = '', desc = ''){
  createLightbox();
  const overlay = document.getElementById('__catalog_lightbox');
  const img = overlay.querySelector('img');
  overlay.querySelector('.title').textContent = title || '';
  overlay.querySelector('.desc').textContent = desc || '';
  img.src = src || 'images/placeholder.png';
  img.alt = title || 'Imagen del producto';
  overlay.classList.add('open');
  overlay.querySelector('.lightbox-close').focus();
}
function closeLightbox(){
  const overlay = document.getElementById('__catalog_lightbox');
  if (!overlay) return;
  overlay.classList.remove('open');
  setTimeout(()=>{ try{ overlay.querySelector('img').src = ''; }catch(_){} }, 200);
}

/* CART: simple local cart with persistence, drawer UI and qty controls */
const CART_KEY = 'catalog:cart_v1';

function getProductKey(obj){ return String(obj.id ?? obj._id ?? obj.nombre ?? obj.name); }
function readCart(){ try{ return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }catch{ return []; } }
function writeCart(cart){ localStorage.setItem(CART_KEY, JSON.stringify(cart)); updateCartBadge(); }

function updateCartBadge(){ const count = readCart().reduce((s,i)=>s+i.qty,0); const el = document.getElementById('cartCount'); if(el) el.textContent = String(count); if(count>0){ el.classList.add('has-items'); el.animate?.([{ transform: 'scale(1)' },{ transform: 'scale(1.12)' },{ transform: 'scale(1)' }], { duration: 320 }); } }

/* showQuantitySelector: minimal, scoped modal to choose quantity before adding to cart */
function showQuantitySelector(productId, sourceEl = null){
  try{
    // avoid duplicates
    const existing = document.getElementById('__qty_selector');
    if (existing) existing.remove();

    const prod = products.find(x => String(x.id ?? x._id) === String(productId));
    const title = prod ? (prod.nombre || prod.name || '') : (productId || 'Producto');
    let qty = 1;

    const overlay = document.createElement('div');
    overlay.id = '__qty_selector';
    overlay.className = 'qty-overlay';
    const imgSrc = prod?.imagen || prod?.image || prod?.image_url || 'images/placeholder.png';
    const unitPrice = Number(prod?.precio ?? prod?.price ?? 0) || 0;
    overlay.innerHTML = `
      <div class="qty-box" role="dialog" aria-modal="true" aria-label="Seleccionar cantidad">
        <div class="qb-top"><img class="qb-img" src="${imgSrc}" alt="${escapeHtml(String(title))}"></div>
        <div class="qb-head"><strong>${escapeHtml(String(title))}</strong></div>
        <div class="qb-controls">
          <button class="qb-dec" aria-label="Disminuir cantidad">−</button>
          <div class="qb-val" aria-live="polite">1</div>
          <button class="qb-inc" aria-label="Aumentar cantidad">+</button>
        </div>
        <div class="qb-price">Precio unitario: $${Number(unitPrice).toFixed(2)}</div>
        <div class="qb-total">Total: $${Number(unitPrice * qty).toFixed(2)}</div>
        <div class="qb-actions"><button class="btn btn-ghost qb-cancel">Cancelar</button><button class="btn btn-primary qb-confirm">Agregar</button></div>
      </div>`;
    document.body.appendChild(overlay);

    const styleId = '__qty_selector_styles';
    if (!document.getElementById(styleId)){
      const s = document.createElement('style'); s.id = styleId; s.textContent = `
        .qty-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(6,26,43,0.32);z-index:1550}
        .qty-box{background:#fff;border-radius:12px;padding:14px;width:320px;max-width:92%;box-shadow:0 20px 60px rgba(6,26,43,0.16);border:1px solid rgba(6,26,43,0.04);display:flex;flex-direction:column;gap:12px;align-items:center}
        .qb-top{width:100%}
        .qb-img{width:100%;height:140px;object-fit:contain;border-radius:8px;background:linear-gradient(180deg,#fafafa,#fff);margin-bottom:8px}
        .qb-head{font-size:15px;color:var(--deep);text-align:center}
        .qb-controls{display:flex;align-items:center;gap:12px}
        .qb-controls .qb-val{min-width:46px;text-align:center;font-weight:800}
        .qb-controls button{width:44px;height:44px;border-radius:10px;border:1px solid rgba(6,26,43,0.06);background:#fff;font-size:20px}
        .qb-actions{display:flex;gap:8px;justify-content:flex-end;width:100%}
      `; document.head.appendChild(s);
    }

    const valEl = overlay.querySelector('.qb-val');
    const inc = overlay.querySelector('.qb-inc');
    const dec = overlay.querySelector('.qb-dec');
    const confirm = overlay.querySelector('.qb-confirm');
    const cancel = overlay.querySelector('.qb-cancel');

    const totalEl = overlay.querySelector('.qb-total');
    function refresh() { valEl.textContent = String(qty); try{ totalEl.textContent = `Total: $${Number(unitPrice * qty).toFixed(2)}`; totalEl.classList.add('pulse'); setTimeout(()=> totalEl.classList.remove('pulse'), 220); }catch(_){} }
    inc.addEventListener('click', ()=>{ if (qty < 99) qty += 1; refresh(); });
    dec.addEventListener('click', ()=>{ if (qty > 1) qty -= 1; refresh(); });
    cancel.addEventListener('click', ()=>{ overlay.remove(); });
    confirm.addEventListener('click', ()=>{ try{ addToCart(String(productId), qty, sourceEl); openCart(String(productId)); }catch(e){console.error(e);} finally{ overlay.remove(); } });

    const onKey = (ev)=>{ if (ev.key === 'Escape') { overlay.remove(); window.removeEventListener('keydown', onKey); } if (ev.key === 'Enter') { confirm.click(); } };
    window.addEventListener('keydown', onKey);
    setTimeout(()=>{ confirm.focus(); }, 40);
  }catch(err){ console.error('showQuantitySelector', err); }
}

function addToCart(productId, qty = 1, sourceEl = null){
  const cart = readCart();
  const idx = cart.findIndex(i=>i.id===productId);
  if(idx>=0){
    cart[idx].qty = Math.min(99, cart[idx].qty + qty);
    writeCart(cart);
    renderCart();
    pulseCard(productId);
    return;
  }

  // Special handling for promo-summary items (id like 'promo:123')
  if (String(productId).startsWith('promo:')){
    const promoId = String(productId).split(':')[1];
    const promo = promotions.find(p => String(p.id) === String(promoId));
    if (promo) {
      const included = (Array.isArray(promo.productIds) ? promo.productIds : []).map(pidItem => {
        const prod = products.find(p => String(p.id ?? p._id) === String(pidItem) || String(p.nombre || p.name || '') === String(pidItem));
        if (!prod) return null;
        const unitBase = Number(prod.precio ?? prod.price ?? 0) || 0;
        const discounted = getDiscountedPrice(unitBase, promo);
        return { id: String(prod.id ?? prod._id ?? pidItem), name: prod.nombre || prod.name || '', price: Number(discounted || unitBase), image: prod.imagen || prod.image || '' };
      }).filter(Boolean);

      // if nothing matched, don't add an empty promo
      if (included.length === 0) return;

      const total = included.reduce((s,i) => s + Number(i.price || 0), 0);
      cart.push({ id: String(productId), qty: Math.min(99, qty), meta: { name: promo.name || 'Promoción', price: Number(total.toFixed(2)), image: included[0].image || '', products: included } });
      writeCart(cart);
      renderCart();
      // no per-product pulse animation; briefly pulse cart instead
      try{ document.getElementById('cartButton')?.animate?.([{ transform: 'scale(1)' },{ transform: 'scale(1.06)' },{ transform: 'scale(1)' }], { duration: 380 }); }catch(_){}
      return;
    }
    return;
  }

  // Default single product add
  const p = products.find(x => String(x.id ?? x._id) === String(productId));
  if (!p) return; // avoid adding unknown ids
  cart.push({ id: String(productId), qty: Math.min(99, qty), meta: { name: p?.nombre || p?.name || '', price: p?.precio ?? p?.price ?? 0, image: p?.imagen || p?.image || p?.image_url || '' } });
  writeCart(cart);
  renderCart();
  pulseCard(productId);
  // fly animation from the source image to cart
  if (sourceEl && !reduceMotion) animateFlyToCart(sourceEl);
}
function setCartItem(productId, qty){ const cart = readCart(); const idx = cart.findIndex(i=>i.id===productId); if(idx>=0){ if(qty<=0) cart.splice(idx,1); else cart[idx].qty = Math.min(99, qty); writeCart(cart); renderCart(); } }
function removeFromCart(productId){ const cart = readCart().filter(i=>i.id!==productId); writeCart(cart); renderCart(); }
function clearCart(){ writeCart([]); renderCart(); }

function pulseCard(productId){ const sel = `[data-pid="${productId}"]`; const card = document.querySelector(sel); if(!card) return; card.classList.add('added'); setTimeout(()=>card.classList.remove('added'), 600); }

function renderCart(){ const container = document.getElementById('cartItems'); const subtotalEl = document.getElementById('cartSubtotal'); const cart = readCart(); container.innerHTML = '';
  if(cart.length===0){ container.innerHTML = '<div class="cart-empty">Tu carrito está vacío</div>'; subtotalEl.textContent = '$0.00'; updateCartBadge(); return; }
  let subtotal = 0; cart.forEach(item=>{ const row = document.createElement('div'); row.className = 'cart-item'; row.dataset.pid = item.id; const img = document.createElement('div'); img.className = 'ci-image'; img.innerHTML = `<img src="${item.meta?.image || 'images/placeholder.png'}" alt="${escapeHtml(item.meta?.name||'')}">`; const info = document.createElement('div'); info.className = 'ci-info';
    // prefer live product data (to reflect promotions), fallback to stored meta
    const prod = products.find(x => String(x.id ?? x._id) === String(item.id));
    const livePriceBase = prod ? (prod.precio ?? prod.price ?? item.meta?.price ?? 0) : (item.meta?.price ?? 0);
    const promo = getBestPromotionForProduct(prod || item);
    const unitPrice = promo ? getDiscountedPrice(livePriceBase, promo) : livePriceBase;
    // build name and price HTML, support promo-summary items that include multiple products
    let nameHtml = `<div class="ci-name">${escapeHtml(item.meta?.name||prod?.nombre||'')}</div>`;
    if (Array.isArray(item.meta?.products) && item.meta.products.length) {
      const lines = item.meta.products.map(x => `${escapeHtml(x.name || x.id)} — $${Number(x.price || 0).toFixed(2)}`);
      nameHtml += `<div class="ci-sub" style="font-size:12px;color:var(--muted);margin-top:6px">${lines.join('<br>')}</div>`;
    }

    const priceHtml = promo ? `<span class="price-new">$${Number(unitPrice).toFixed(2)}</span> <span class="price-old">$${Number(livePriceBase).toFixed(2)}</span> <small style="color:var(--muted);margin-left:6px">(${escapeHtml(promo.name||'promo')})</small>` : `$${Number(unitPrice).toFixed(2)}`;
    info.innerHTML = `${nameHtml}<div class="ci-price">${priceHtml}</div>`;
    const controls = document.createElement('div'); controls.className = 'ci-controls'; controls.innerHTML = `<div class="qty" role="group" aria-label="Cantidad"><button class="qty-dec" aria-label="Disminuir">−</button><div class="val" aria-live="polite">${item.qty}</div><button class="qty-inc" aria-label="Aumentar">+</button></div><button class="btn btn-ghost remove">Eliminar</button>`;
    row.appendChild(img); row.appendChild(info); row.appendChild(controls); container.appendChild(row);
    subtotal += Number(unitPrice || 0) * item.qty;
    // bindings
    controls.querySelector('.qty-inc').addEventListener('click', ()=> setCartItem(item.id, item.qty+1));
    controls.querySelector('.qty-dec').addEventListener('click', ()=> setCartItem(item.id, item.qty-1));
    controls.querySelector('.remove').addEventListener('click', ()=> removeFromCart(item.id));
  });
  // animate subtotal change
  try{
    const newVal = Number(subtotal).toFixed(2);
    const prev = parseFloat(subtotalEl.dataset.prev || '0');
    subtotalEl.dataset.prev = String(newVal);
    subtotalEl.innerHTML = `Total: <span class="amount">$${newVal}</span>`;
    const amt = subtotalEl.querySelector('.amount');
    if (amt){
      // pulse when value changes
      if (Number(newVal) !== Number(prev)) { amt.classList.add('pulse'); setTimeout(()=>amt.classList.remove('pulse'), 280); }
    }
  }catch(e){ subtotalEl.textContent = `$${Number(subtotal).toFixed(2)}`; }
  updateCartBadge(); }

function openCart(prefillId){ const drawer = document.getElementById('cartDrawer'); drawer.setAttribute('aria-hidden','false'); drawer.classList.add('open'); renderCart(); const btn = document.getElementById('cartButton'); btn.setAttribute('aria-expanded','true'); setTimeout(()=>{ const focusTarget = prefillId ? document.querySelector(`.cart-item[data-pid="${prefillId}"] .qty .val`) : document.getElementById('cartItems'); if(focusTarget) focusTarget.focus(); }, 120);
}
function closeCart(){ const drawer = document.getElementById('cartDrawer'); drawer.setAttribute('aria-hidden','true'); drawer.classList.remove('open'); const btn = document.getElementById('cartButton'); btn.setAttribute('aria-expanded','false'); }

// bindings for cart UI
(function bindCartUI(){
  document.addEventListener('click',(ev)=>{ 
    const add = ev.target.closest && ev.target.closest('.btn-add'); 
    if(add){ 
      ev.preventDefault(); ev.stopPropagation(); 
      const id = add.dataset.id; 
      // try to find the product image in the same card to animate from
      const card = add.closest && add.closest('.product-card');
      const img = card && card.querySelector('img');
      showQuantitySelector(String(id), img || null);
      return; 
    } 
  });

  const fab = document.getElementById('cartButton'); if(fab) fab.addEventListener('click', ()=>{ const drawer = document.getElementById('cartDrawer'); if(drawer.getAttribute('aria-hidden')==='true') openCart(); else closeCart(); });
  const closeBtn = document.getElementById('closeCart'); if(closeBtn) closeBtn.addEventListener('click', closeCart);
  const clearBtn = document.getElementById('clearCart'); if(clearBtn) clearBtn.addEventListener('click', ()=>{ if(confirm('Vaciar el carrito?')) clearCart(); });
  const checkout = document.getElementById('checkoutBtn');
  if (checkout) {
    // ensure label matches requested copy
    checkout.textContent = checkout.textContent.trim() || 'Hacer pedido';
    checkout.setAttribute('aria-label', 'Hacer pedido');
    checkout.addEventListener('click', async () => {
        const cart = readCart();
        if (!cart || cart.length === 0) return alert('El carrito está vacío');
        const basePayload = { items: cart, total: cart.reduce((s, i) => s + (Number(i.meta?.price || 0) * i.qty), 0) };

        // attach user info if logged in; validate presence of contact fields and confirm
        const token = getToken();
        if (token) {
          try {
            const profileRes = await fetch(`${API_ORIGIN}/auth/me`, { headers: { 'Authorization': `Bearer ${token}` }, mode: 'cors' });
            if (profileRes.ok) {
              const profile = await profileRes.json();
              // If profile missing contact fields, ask user to confirm before proceeding
              const missing = [];
              if (!profile.user_full_name && !profile.full_name) missing.push('nombre');
              if (!profile.email) missing.push('email');
              if (!profile.barrio) missing.push('barrio');
              if (!profile.calle) missing.push('calle');
              if (!profile.numeracion) missing.push('numeración');
              if (missing.length) {
                const ok = confirm('Tu perfil está incompleto (faltan: ' + missing.join(', ') + '). ¿Deseas continuar y enviar el pedido igualmente?');
                if (!ok) { try { document.getElementById('checkoutBtn').disabled = false; } catch(e){}; return; }
              }
              basePayload.user_id = profile.id;
              basePayload.user_full_name = profile.full_name;
              basePayload.user_email = profile.email;
              basePayload.user_barrio = profile.barrio;
              basePayload.user_calle = profile.calle;
              basePayload.user_numeracion = profile.numeracion;
            }
          } catch (e) { /* ignore profile fetch errors */ }
        }
        const payload = basePayload;

      const btn = document.getElementById('checkoutBtn');
      btn.disabled = true;

      // Try local (same-origin) orders endpoint first so orders reach the local admin panel during dev.
      // Fallback to configured API origin if same-origin is unreachable.
      // Prefer the configured API origin first (ensures orders reach the backend),
      // then fall back to same-origin '/orders' as a last resort for local admin-hosted pages.
      // Prefer API_ORIGIN when it's different from the page origin (Netlify/static hosting),
      // otherwise use the page origin. Always keep '/orders' as a last-resort fallback.
      const tryUrls = [];
      try {
        const pageOrigin = (location && location.protocol && location.protocol.startsWith('http') && location.origin) ? location.origin : null;
        if (typeof API_ORIGIN === 'string' && API_ORIGIN) {
          if (pageOrigin && pageOrigin !== API_ORIGIN) {
            tryUrls.push(API_ORIGIN + '/orders');
            tryUrls.push(pageOrigin + '/orders');
          } else {
            // API_ORIGIN equals page origin or pageOrigin not available
            tryUrls.push((pageOrigin || API_ORIGIN) + '/orders');
          }
        } else if (pageOrigin) {
          tryUrls.push(pageOrigin + '/orders');
        }
      } catch (e) {}
      tryUrls.push('/orders');
      // remove falsy entries
      for (let i = tryUrls.length - 1; i >= 0; i--) if (!tryUrls[i]) tryUrls.splice(i, 1);

      let succeeded = false;
      // Attach Authorization header when token present
      const authToken = getToken();
      const baseHeaders = { 'Content-Type': 'application/json' };
      if (authToken) baseHeaders['Authorization'] = `Bearer ${authToken}`;

      for (const url of tryUrls) {
        try {
          const res = await fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify(payload), mode: 'cors' });
          if (!res.ok) throw new Error(`status:${res.status}`);
          succeeded = true;
          break;
        } catch (err) {
          console.warn('checkout attempt failed for', url, err);
          // try next url
        }
      }

      try {
        if (succeeded) {
          // confirm visually and clear
          alert('Pedido enviado — el panel de administración recibirá la orden.');
          clearCart(); closeCart();
        } else {
          // graceful fallback: keep el carrito (NO WhatsApp), mostrar modal con opciones al usuario
          console.warn('Checkout failed — showing fallback modal and keeping cart locally.');
          showOrderModal(payload);
        }
      } catch (err) {
        console.error('post-checkout-handling', err);
      } finally {
        try { document.getElementById('checkoutBtn').disabled = false; } catch (e) {}
      }
    });
  }
  /* helper: muestra modal accesible con resumen del pedido y opciones (copiar, descargar, reintentar) */
  function showOrderModal(payload){
    try{
      if(document.getElementById('__order_modal')) return document.getElementById('__order_modal').classList.add('open');
      const modal = document.createElement('div');
      modal.id = '__order_modal';
      modal.className = 'order-modal-overlay';
      const itemsHtml = (payload.items || []).map(i=>`<li style="margin:8px 0"><strong>${escapeHtml(String(i.meta?.name||i.id))}</strong> — ${i.qty} × $${Number(i.meta?.price||0).toFixed(2)}</li>`).join('');
      modal.innerHTML = `
        <div class="order-modal" role="dialog" aria-modal="true" aria-label="Resumen del pedido">
          <header style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
            <h3 style="margin:0">Pedido (guardado localmente)</h3>
            <button class="om-close" aria-label="Cerrar">✕</button>
          </header>
          <div style="max-height:52vh;overflow:auto;padding:6px 2px;margin-bottom:12px;color:var(--deep);">
            <ul style="list-style:none;padding:0;margin:0 0 8px">${itemsHtml || '<li style="color:var(--muted)">(sin ítems)</li>'}</ul>
            <div style="font-weight:800;margin-top:8px">Total: <span>$${Number(payload.total||0).toFixed(2)}</span></div>
            <p style="color:var(--muted);margin-top:8px">No se pudo enviar la orden al servidor — puedes <strong>reintentar</strong>, <strong>copiar</strong> o <strong>descargar</strong> el pedido.</p>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center">
            <button class="btn btn-ghost om-copy">Copiar pedido</button>
            <button class="btn btn-ghost om-download">Descargar JSON</button>
            <button class="btn btn-primary om-retry">Reintentar</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      // styles for modal (scoped minimal) — won't override global theme
      const ss = document.createElement('style'); ss.id = '__order_modal_styles'; ss.textContent = `
        .order-modal-overlay{ position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,0.45);z-index:1400;opacity:0;pointer-events:none;transition:opacity .18s ease}
        .order-modal-overlay.open{opacity:1;pointer-events:auto}
        .order-modal{width:520px;max-width:calc(100% - 36px);background:var(--surface);border-radius:14px;padding:18px;box-shadow:var(--shadow-lg);border:1px solid rgba(10,34,64,0.04);color:var(--deep)}
        .order-modal .om-close{background:transparent;border:0;color:var(--muted);font-size:18px;cursor:pointer}
        @media(max-width:640px){ .order-modal{width:calc(100% - 28px)} }
      `; document.head.appendChild(ss);
      requestAnimationFrame(()=> modal.classList.add('open'));
      // bindings
      modal.querySelector('.om-close').addEventListener('click', ()=> modal.remove());
      modal.querySelector('.om-copy').addEventListener('click', ()=>{ copyOrderToClipboard(payload); });
      modal.querySelector('.om-download').addEventListener('click', ()=>{ const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); a.download = `pedido-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove(); });
      modal.querySelector('.om-retry').addEventListener('click', async (ev)=>{
        ev.target.disabled = true;
        const ok = await reAttemptOrder(payload);
        ev.target.disabled = false;
        if (ok) { modal.remove(); alert('Pedido enviado — el panel de administración recibirá la orden.'); clearCart(); closeCart(); }
        else { alert('No se pudo enviar la orden. Puedes copiar o descargar el pedido y enviarlo manualmente.'); }
      });
      // focus
      const focusable = modal.querySelector('.om-retry') || modal.querySelector('.om-copy');
      if (focusable) focusable.focus();
      // close on Esc
      const onKey = (ev)=>{ if (ev.key === 'Escape') { modal.remove(); window.removeEventListener('keydown', onKey); } };
      window.addEventListener('keydown', onKey);
    }catch(err){ console.error('showOrderModal', err); alert('No se pudo mostrar el modal del pedido — revisa la consola.'); }
  }

  function copyOrderToClipboard(payload){
    try{
      const lines = (payload.items||[]).map(i=>`${i.qty} × ${i.meta?.name || i.id} — $${Number(i.meta?.price||0).toFixed(2)}`);
      const txt = `Pedido:\n${lines.join('\n')}\n\nTotal: $${Number(payload.total||0).toFixed(2)}`;
      navigator.clipboard?.writeText ? navigator.clipboard.writeText(txt) : (function(){ const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); })();
      alert('Resumen del pedido copiado al portapapeles.');
    }catch(e){ console.error('copyOrder', e); alert('No se pudo copiar el pedido automáticamente.'); }
  }

  async function reAttemptOrder(payload){
    // ensure user info included when reattempting
    const token = getToken();
    if (token) {
      try {
        const profileRes = await fetch(`${API_ORIGIN}/auth/me`, { headers: { 'Authorization': `Bearer ${token}` }, mode: 'cors' });
        if (profileRes.ok) {
          const profile = await profileRes.json();
          payload.user_id = payload.user_id || profile.id;
          payload.user_full_name = payload.user_full_name || profile.full_name;
          payload.user_email = payload.user_email || profile.email;
          payload.user_barrio = payload.user_barrio || profile.barrio;
          payload.user_calle = payload.user_calle || profile.calle;
          payload.user_numeracion = payload.user_numeracion || profile.numeracion;
        }
      } catch (e) { /* ignore */ }
    }

    // Prefer the configured API origin first when re-attempting an order
    // Prefer API_ORIGIN when it's different from the page origin (Netlify/static hosting),
    // otherwise use the page origin. Always keep '/orders' as a last-resort fallback.
    const tryUrls = [];
    try {
      const pageOrigin = (location && location.protocol && location.protocol.startsWith('http') && location.origin) ? location.origin : null;
      if (typeof API_ORIGIN === 'string' && API_ORIGIN) {
        if (pageOrigin && pageOrigin !== API_ORIGIN) {
          tryUrls.push(API_ORIGIN + '/orders');
          tryUrls.push(pageOrigin + '/orders');
        } else {
          tryUrls.push((pageOrigin || API_ORIGIN) + '/orders');
        }
      } else if (pageOrigin) {
        tryUrls.push(pageOrigin + '/orders');
      }
    } catch (e) {}
    tryUrls.push('/orders');
    for (let i = tryUrls.length - 1; i >= 0; i--) if (!tryUrls[i]) tryUrls.splice(i, 1);
    const authToken = getToken();
    const baseHeaders = { 'Content-Type': 'application/json' };
    if (authToken) baseHeaders['Authorization'] = `Bearer ${authToken}`;
    for (const url of tryUrls){
      try{
        const res = await fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify(payload), mode: 'cors' });
        if (res.ok) return true;
      }catch(_){ }
    }
    return false;
  }

  // close on outside click
  document.addEventListener('pointerdown', (ev)=>{ const drawer = document.getElementById('cartDrawer'); const fab = document.getElementById('cartButton'); if(!drawer || drawer.getAttribute('aria-hidden')==='true') return; if(ev.target.closest && (ev.target.closest('#cartDrawer') || ev.target.closest('#cartButton'))) return; closeCart(); });
  // initialize badge
  updateCartBadge();
})();


// auto-refresh (soft by default: re-fetch; full = location.reload())
function startAutoRefresh() {
  stopAutoRefresh();
  const mode = localStorage.getItem('catalog:auto:mode') || 'soft';
  const enabled = localStorage.getItem('catalog:auto:enabled') !== 'false';
  const countdownEl = document.getElementById('refreshCountdown');
  const modeEl = document.getElementById('autoMode');
  modeEl.textContent = mode;
  if (!enabled) {
    countdownEl.textContent = '—';
    return;
  }
  countdown = AUTO_REFRESH_SECONDS;
  countdownEl.textContent = String(countdown);
  // interval that performs refresh action
  autoTimer = setInterval(() => {
    if (mode === 'full') {
      location.reload();
    } else {
      fetchProducts({ showSkeleton: false });
    }
    countdown = AUTO_REFRESH_SECONDS;
  }, AUTO_REFRESH_SECONDS * 1000);
  // tick every second for UI
  countdownTimer = setInterval(() => {
    countdown -= 1;
    if (countdown <= 0) countdown = AUTO_REFRESH_SECONDS;
    countdownEl.textContent = String(countdown);
  }, 1000);
}

function stopAutoRefresh() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function updateLastUpdated(local = false) {
  const el = document.getElementById('lastUpdated');
  if (!el) return; // element removed — nothing to do
  const when = new Date();
  el.textContent = `Última actualización: ${when.toLocaleTimeString()} ${local ? '(local)' : ''}`;
}

// UI bindings for auto-refresh control
(function bindAutoControls(){
  const toggle = document.getElementById('autoRefreshToggle');
  const modeEl = document.getElementById('autoMode');
  const statusEl = document.getElementById('autoStatus');
  // restore
  const enabled = localStorage.getItem('catalog:auto:enabled');
  const mode = localStorage.getItem('catalog:auto:mode') || 'soft';
  toggle.checked = (enabled === null) ? true : (enabled === 'true');
  modeEl.textContent = mode;
  // set visual status badge
  if (statusEl) {
    const on = toggle.checked;
    statusEl.classList.remove('on','off');
    statusEl.classList.add(on ? 'on' : 'off');
    statusEl.innerHTML = `<span class="dot"></span> ${on ? 'Activado' : 'Desactivado'}`;
  }
  // when user toggles auto-refresh on/off
  toggle.addEventListener('change', (e) => {
    const on = e.target.checked;
    localStorage.setItem('catalog:auto:enabled', String(on));
    if (on) startAutoRefresh(); else stopAutoRefresh();
    if (statusEl) { statusEl.classList.remove('on','off'); statusEl.classList.add(on ? 'on' : 'off'); statusEl.innerHTML = `<span class="dot"></span> ${on ? 'Activado' : 'Desactivado'}`; }
  });
  // switch mode on double-click of the mode label (soft <-> full)
  modeEl.parentElement.addEventListener('dblclick', (ev) => {
    const next = (localStorage.getItem('catalog:auto:mode') || 'soft') === 'soft' ? 'full' : 'soft';
    localStorage.setItem('catalog:auto:mode', next);
    modeEl.textContent = next;
    // immediate feedback: restart with new mode
    if (toggle.checked) startAutoRefresh();
  });
})();

// wire clear button (if present)
// small helper to avoid XSS when inserting strings into innerHTML
// --- Auth helpers (login/register modal + token storage) ---
function saveToken(token){
  try{ localStorage.setItem('access_token', token); }catch(e){}
}
function getToken(){ try{ return localStorage.getItem('access_token'); }catch(e){ return null; } }
function clearToken(){ try{ localStorage.removeItem('access_token'); }catch(e){} }
function parseJwt(token){
  try{
    const b = token.split('.')[1];
    const json = decodeURIComponent(atob(b).split('').map(function(c){ return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''));
    return JSON.parse(json);
  }catch(e){ return null; }
}

// small toast helper
function showToast(message, timeout = 3000){
  try{
    let container = document.getElementById('__toast_container');
    if(!container){ container = document.createElement('div'); container.id='__toast_container'; container.style.position='fixed'; container.style.right='20px'; container.style.bottom='20px'; container.style.zIndex='3000'; container.style.display='flex'; container.style.flexDirection='column'; container.style.gap='8px'; document.body.appendChild(container); }
    const t = document.createElement('div');
    t.className = '__toast';
    t.style.background = 'linear-gradient(90deg,var(--accent),var(--accent-2))';
    t.style.color = '#fff';
    t.style.padding = '10px 14px';
    t.style.borderRadius = '10px';
    t.style.boxShadow = '0 12px 36px rgba(2,6,23,0.18)';
    t.style.fontWeight = '800';
    t.style.minWidth = '180px';
    t.style.maxWidth = '320px';
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    t.textContent = message;
    container.appendChild(t);
    requestAnimationFrame(()=>{ t.style.transition = 'all 260ms ease'; t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
    setTimeout(()=>{ try{ t.style.opacity='0'; t.style.transform='translateY(8px)'; setTimeout(()=>t.remove(), 280); }catch(e){} }, timeout);
  }catch(e){ console.warn('showToast failed', e); }
}
function updateAuthUI(){ const btn = document.getElementById('authButton'); const token = getToken(); if (!btn) return; if (token){ const payload = parseJwt(token) || {}; const email = payload.sub || payload.email || 'Cuenta'; btn.textContent = `Hola ${email}`; btn.classList.add('logged'); } else { btn.textContent = 'Login'; btn.classList.remove('logged'); } }
async function doRegister(){ const name=document.getElementById('regName').value.trim(); const email=document.getElementById('regEmail').value.trim(); const barrio=document.getElementById('regBarrio').value.trim(); const calle=document.getElementById('regCalle').value.trim(); const numero=document.getElementById('regNumero').value.trim(); const password=document.getElementById('regPassword').value; const err=document.getElementById('regError'); err.textContent=''; if(!name||!email||!password){ err.textContent='Nombre, email y contraseña son obligatorios'; return; } try{ const res=await fetch(AUTH_REGISTER,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name:name,email,barrio,calle,numeracion:numero,password})}); if(res.status===400){ const js=await res.json().catch(()=>({})); err.textContent=js.detail||'Error'; return; } if(!res.ok){ err.textContent='Registro falló'; return; } await doLogin(email,password); closeAuthModal(); }catch(e){ err.textContent='Error de red'; } }
async function doLogin(emailArg,passwordArg){
  const email = emailArg || document.getElementById('loginEmail').value.trim();
  const password = passwordArg || document.getElementById('loginPassword').value;
  const err = document.getElementById('loginError'); err.textContent = '';
  if (!email || !password) { err.textContent = 'Email y contraseña son obligatorios'; return; }
  try {
    const form = new URLSearchParams(); form.append('username', email); form.append('password', password);
    const res = await fetch(AUTH_TOKEN, { method: 'POST', body: form });
    if (!res.ok) { const j = await res.json().catch(() => ({})); err.textContent = j.detail || 'Credenciales incorrectas'; return; }
    const data = await res.json();
    if (data && data.access_token) {
      saveToken(data.access_token);
      updateAuthUI();
      // derive display name from token if available
      let name = email;
      try { const p = parseJwt(data.access_token); if (p) name = p.full_name || p.name || p.sub || p.email || email; } catch (e) {}
      closeAuthModal();
      showToast(`Bienvenido, ${name}`);
      // mark that auth modal was shown this session (ensure consistent behavior)
      try { sessionStorage.setItem('catalog:auth_shown', '1'); } catch(e) {}
    }
  } catch (e) { err.textContent = 'Error de red'; }
}
function logout(){ clearToken(); updateAuthUI(); }
function _authOutsideClick(e){
  const m = document.getElementById('authModal');
  if (!m) return;
  const content = m.querySelector('.modal-content');
  if (!content) return;
  if (!content.contains(e.target)) closeAuthModal();
}

function openAuthModal(){
  const m = document.getElementById('authModal'); if(!m) return;
  m.classList.add('open');
  m.setAttribute('aria-hidden','false');
  document.body.classList.add('modal-open');
  // ensure login tab shown by default
  const loginPanel = document.getElementById('loginForm');
  const registerPanel = document.getElementById('registerForm');
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  if (tabLogin && tabRegister){ tabLogin.classList.add('active'); tabRegister.classList.remove('active'); }
  if (loginPanel && registerPanel){ loginPanel.style.display = 'block'; registerPanel.style.display = 'none'; }
  // focus first field
  setTimeout(()=>{ try{ document.getElementById('loginEmail')?.focus(); }catch(e){} }, 120);
  // close when clicking outside content
  setTimeout(()=>{ document.addEventListener('pointerdown', _authOutsideClick); }, 40);
}

function closeAuthModal(){
  const m = document.getElementById('authModal'); if(!m) return;
  m.classList.remove('open');
  m.setAttribute('aria-hidden','true');
  document.body.classList.remove('modal-open');
  try{ document.removeEventListener('pointerdown', _authOutsideClick); }catch(_){}
}

// wire auth modal and button (DOMContentLoaded handled later)
document.addEventListener('DOMContentLoaded', ()=>{
  updateAuthUI();
  const authBtn = document.getElementById('authButton');
  if (authBtn) authBtn.addEventListener('click', ()=>{
    const token = getToken();
    if (token){ if (confirm('Cerrar sesión?')) { logout(); } return; }
    openAuthModal();
  });
  const authClose = document.getElementById('authClose'); if (authClose) authClose.addEventListener('click', closeAuthModal);
  const tabLogin = document.getElementById('tabLogin'); const tabRegister = document.getElementById('tabRegister');
  if (tabLogin && tabRegister){
    tabLogin.addEventListener('click', ()=>{ tabLogin.classList.add('active'); tabRegister.classList.remove('active'); document.getElementById('loginForm').style.display='block'; document.getElementById('registerForm').style.display='none'; setTimeout(()=>document.getElementById('loginEmail')?.focus(),80); });
    tabRegister.addEventListener('click', ()=>{ tabRegister.classList.add('active'); tabLogin.classList.remove('active'); document.getElementById('loginForm').style.display='none'; document.getElementById('registerForm').style.display='block'; setTimeout(()=>document.getElementById('regName')?.focus(),80); });
  }
  const doLoginBtn = document.getElementById('doLogin'); if (doLoginBtn) doLoginBtn.addEventListener('click', ()=>doLogin());
  const doRegisterBtn = document.getElementById('doRegister'); if (doRegisterBtn) doRegisterBtn.addEventListener('click', ()=>doRegister());
  // Auto-open modal on entry if user not logged in (per request)
  try{
    if (!getToken()) {
      // show modal only once per session
      const shown = sessionStorage.getItem('catalog:auth_shown');
      if (!shown) {
        setTimeout(()=> { openAuthModal(); try{ sessionStorage.setItem('catalog:auth_shown','1'); }catch(e){} }, 600);
      }
    }
  }catch(e){}
});

// Ensure fetchProducts includes Authorization header when token present
const _origFetchProducts = typeof fetchProducts === 'function' ? fetchProducts : null;

// Initialize UI after DOM is ready. Defensive: ensures elements exist so mobile
// browsers that load scripts early don't cause a hard error that stops rendering.
function init(){
  try{
    grid = document.getElementById("catalogGrid") || (function(){ const s = document.createElement('section'); s.id='catalogGrid'; document.body.appendChild(s); return s;} )();
    searchInput = document.getElementById("searchInput") || (function(){ const i = document.createElement('input'); i.id='searchInput'; i.type='search'; document.body.insertBefore(i, grid); return i;} )();
    filterButtons = document.querySelectorAll(".filters button") || [];

    // initial load
    try{ fetchProducts(); }catch(e){ console.error('fetchProducts init failed', e); showMessage('No se pudieron cargar productos', 'error'); }
    // ensure auto-refresh is enabled by default (unless explicitly disabled by the user)
    if (localStorage.getItem('catalog:auto:enabled') === null) localStorage.setItem('catalog:auto:enabled','true');
    // start auto-refresh if enabled
    startAutoRefresh();

    if (searchInput) searchInput.addEventListener("input", () => { render({ animate: true }); });

    // wire clear button (if present)
    const clearBtn = document.querySelector('.search-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        try { searchInput.value = ''; searchInput.focus(); render({ animate: true }); } catch (e) { console.error(e); }
      });
    }

    if (filterButtons && filterButtons.forEach) {
      filterButtons.forEach(btn => {
        btn.addEventListener("click", () => {
          filterButtons.forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          currentFilter = btn.dataset.filter;
          render({ animate: true });
        });
      });
    }
  }catch(err){ console.error('init failed', err); }
}

// run init when DOM ready
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

// Create a visible overlay for uncaught errors so mobile users see what's failing
function showOverlayError(msg){
  try{
    let o = document.getElementById('__catalog_error_overlay');
    if (!o){
      o = document.createElement('div'); o.id='__catalog_error_overlay';
      o.style.position='fixed'; o.style.left='12px'; o.style.right='12px'; o.style.top='12px'; o.style.zIndex='2000'; o.style.padding='12px 16px'; o.style.background='#ffecec'; o.style.border='2px solid #ff6b6b'; o.style.borderRadius='10px'; o.style.color='#2b2b2b'; o.style.fontWeight='700'; o.style.boxShadow='0 12px 40px rgba(0,0,0,0.12)';
      const btn = document.createElement('button'); btn.textContent='Cerrar'; btn.style.float='right'; btn.style.marginLeft='10px'; btn.style.background='transparent'; btn.style.border='none'; btn.style.cursor='pointer'; btn.addEventListener('click', ()=>o.remove());
      o.appendChild(btn);
      const txt = document.createElement('div'); txt.id='__catalog_error_text'; txt.style.marginRight='48px'; o.appendChild(txt);
      document.body.appendChild(o);
    }
    const t = document.getElementById('__catalog_error_text'); if (t) t.textContent = String(msg).slice(0,800);
  }catch(e){ console.error('showOverlayError failed', e); }
}

window.addEventListener('error', function(ev){ try{ showOverlayError('Error: '+(ev && ev.message ? ev.message : String(ev))); }catch(e){} });
window.addEventListener('unhandledrejection', function(ev){ try{ showOverlayError('Promise rejection: '+(ev && ev.reason ? String(ev.reason) : String(ev))); }catch(e){} });

// small helper to avoid XSS when inserting strings into innerHTML
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}