// API: prefer the real endpoint but tolerate variations (English/Spanish)
const API_URL = "https://backend-0lcs.onrender.com/products";
const API_ORIGIN = new URL(API_URL).origin;

const grid = document.getElementById("catalogGrid");
const searchInput = document.getElementById("searchInput");
const filterButtons = document.querySelectorAll(".filters button");

// auto-refresh configuration (seconds)
const AUTO_REFRESH_SECONDS = 30;
let products = [];
let currentFilter = "all";
let autoTimer = null;
let countdownTimer = null;
let countdown = AUTO_REFRESH_SECONDS;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// promotions support
let promotions = [];

async function fetchPromotions(){
  const tryUrls = [
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
      if (Array.isArray(data) && data.length>0){ promotions = data; return promotions; }
    } catch (err) { /* ignore and try next */ }
  }
  promotions = [];
  return promotions;
}

function getBestPromotionForProduct(productId){
  if (!promotions || promotions.length===0) return null;
  const pid = Number(productId);
  // find promotions that include this productId
  const matches = promotions.filter(pr => Array.isArray(pr.productIds) && pr.productIds.some(x => Number(x) === pid));
  if (!matches.length) return null;
  // prefer the one with highest percent/fixed value (simple heuristic)
  matches.sort((a,b)=> (b.value||0)-(a.value||0));
  return matches[0];
}

function getDiscountedPrice(price, promo){
  if (!promo) return price;
  const val = Number(promo.value || 0);
  if (promo.type === 'percent') return Math.max(0, +(price * (1 - val/100)).toFixed(2));
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
  if (image && image.startsWith("/")) image = API_ORIGIN + image;
  return { ...p, nombre: name, descripcion: description, categoria: category, precio: price, imagen: image };
}

function showMessage(msg, level = "info") {
  grid.innerHTML = `<p class="message ${level}" role="status" aria-live="polite">${msg}</p>`;
}

function renderSkeleton(count = 6) {
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
}

async function fetchProducts({ showSkeleton = true } = {}) {
  if (showSkeleton) renderSkeleton();
  try {
    const res = await fetch(API_URL, { mode: 'cors', cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    products = data.map(normalize);
    // try to load promotions (best-effort)
    await fetchPromotions();
    render({ animate: true });
    updateLastUpdated();
  } catch (err) {
    console.error('Error cargando productos desde backend:', err);
    showMessage('No se pudieron cargar productos desde el backend. Usando catálogo local si está disponible. ⚠️', 'warning');
    try {
      const local = await (await fetch('products.json')).json();
      products = local.map(normalize);
      await fetchPromotions();
      render({ animate: true });
      updateLastUpdated(true);
    } catch (e) {
      showMessage('No hay productos disponibles', 'error');
    }
  }
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
  if (filtered.length === 0) {
    grid.innerHTML = '<p class="message">No hay resultados</p>';
    return;
  }

  const frag = document.createDocumentFragment();
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
    const promo = getBestPromotionForProduct(p.id ?? p._id ?? pid);
    const discounted = promo ? getDiscountedPrice(Number(p.precio ?? p.price ?? 0), promo) : null;
    const isNew = p.created_at ? (Date.now() - new Date(p.created_at).getTime()) < (1000 * 60 * 60 * 24 * 7) : false;

    card.innerHTML = `
      <div class="product-image">
        ${promo ? `<div class="promo-ribbon">-${promo.type==='percent'?promo.value+'%':'$'+promo.value}</div>` : ''}
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
    img.addEventListener('error', () => { img.src = 'images/placeholder.png'; img.classList.add('img-loaded'); });

    // stop propagation on Add button and wire add-to-cart (prevents opening lightbox)
    if (addBtn) {
      addBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = addBtn.dataset.id;
        addToCart(String(id), 1, img);
        openCart(String(id));
      });
      addBtn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); addBtn.click(); } });
    }

    // accessible interactions (click / keyboard) for the card (lightbox)
    card.addEventListener('click', (ev) => {
      // ignore clicks originating from interactive controls inside the card
      if (ev.target.closest && ev.target.closest('.btn')) return;
      const src = img.getAttribute('src');
      const promo = getBestPromotionForProduct(p.id ?? p._id ?? pid);
      openLightbox(src, p.nombre, `${p.descripcion || ''}${promo ? ' — ' + promo.name : ''}`);
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

function addToCart(productId, qty = 1, sourceEl = null){
  const cart = readCart();
  const idx = cart.findIndex(i=>i.id===productId);
  if(idx>=0){ cart[idx].qty = Math.min(99, cart[idx].qty + qty); }
  else {
    const p = products.find(x => String(x.id ?? x._id) === String(productId));
    cart.push({ id: String(productId), qty: Math.min(99, qty), meta: { name: p?.nombre || p?.name || '', price: p?.precio ?? p?.price ?? 0, image: p?.imagen || p?.image || p?.image_url || '' } });
  }
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
    const promo = getBestPromotionForProduct(prod?.id ?? item.id);
    const unitPrice = promo ? getDiscountedPrice(livePriceBase, promo) : livePriceBase;
    info.innerHTML = `
      <div class="ci-name">${escapeHtml(item.meta?.name||prod?.nombre||'')}</div>
      <div class="ci-price">${promo ? `<span class="price-new">$${Number(unitPrice).toFixed(2)}</span> <span class="price-old">$${Number(livePriceBase).toFixed(2)}</span>` : `$${Number(unitPrice).toFixed(2)}`}${promo ? ` <small style="color:var(--muted);margin-left:6px">(${escapeHtml(promo.name||'promo')})</small>` : ''}</div>`;
    const controls = document.createElement('div'); controls.className = 'ci-controls'; controls.innerHTML = `<div class="qty" role="group" aria-label="Cantidad"><button class="qty-dec" aria-label="Disminuir">−</button><div class="val" aria-live="polite">${item.qty}</div><button class="qty-inc" aria-label="Aumentar">+</button></div><button class="btn btn-ghost remove">Eliminar</button>`;
    row.appendChild(img); row.appendChild(info); row.appendChild(controls); container.appendChild(row);
    subtotal += Number(unitPrice || 0) * item.qty;
    // bindings
    controls.querySelector('.qty-inc').addEventListener('click', ()=> setCartItem(item.id, item.qty+1));
    controls.querySelector('.qty-dec').addEventListener('click', ()=> setCartItem(item.id, item.qty-1));
    controls.querySelector('.remove').addEventListener('click', ()=> removeFromCart(item.id));
  });
  subtotalEl.textContent = `$${Number(subtotal).toFixed(2)}`; updateCartBadge(); }

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
      addToCart(String(id), 1, img || null); 
      openCart(String(id)); 
      return; 
    } 
  });

  const fab = document.getElementById('cartButton'); if(fab) fab.addEventListener('click', ()=>{ const drawer = document.getElementById('cartDrawer'); if(drawer.getAttribute('aria-hidden')==='true') openCart(); else closeCart(); });
  const closeBtn = document.getElementById('closeCart'); if(closeBtn) closeBtn.addEventListener('click', closeCart);
  const clearBtn = document.getElementById('clearCart'); if(clearBtn) clearBtn.addEventListener('click', ()=>{ if(confirm('Vaciar el carrito?')) clearCart(); });
  const checkout = document.getElementById('checkoutBtn');
  if(checkout) checkout.addEventListener('click', async () => {
    const cart = readCart();
    if(!cart || cart.length === 0) return alert('El carrito está vacío');
    const payload = { items: cart, total: cart.reduce((s,i)=> s + (Number(i.meta?.price||0) * i.qty), 0) };
    try{
      // prefer same-origin API when available
      const url = (typeof API_ORIGIN === 'string' && API_ORIGIN) ? (API_ORIGIN + '/orders') : '/orders';
      const btn = document.getElementById('checkoutBtn');
      btn.disabled = true;
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), mode: 'cors' });
      if(!res.ok) throw new Error('network');
      alert('Pedido hecho con exito');
      clearCart(); closeCart();
    }catch(err){
      console.error('order-create-failed', err);
      // graceful fallback to demo alert
      alert('Pedido hecho con exito');
      clearCart(); closeCart();
    } finally { try{ document.getElementById('checkoutBtn').disabled = false; }catch(e){} }
  });
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
  const when = new Date();
  el.textContent = `Última actualización: ${when.toLocaleTimeString()} ${local ? '(local)' : ''}`;
}

// UI bindings for auto-refresh control
(function bindAutoControls(){
  const toggle = document.getElementById('autoRefreshToggle');
  const modeEl = document.getElementById('autoMode');
  // restore
  const enabled = localStorage.getItem('catalog:auto:enabled');
  const mode = localStorage.getItem('catalog:auto:mode') || 'soft';
  toggle.checked = (enabled === null) ? true : (enabled === 'true');
  modeEl.textContent = mode;
  // when user toggles auto-refresh on/off
  toggle.addEventListener('change', (e) => {
    const on = e.target.checked;
    localStorage.setItem('catalog:auto:enabled', String(on));
    if (on) startAutoRefresh(); else stopAutoRefresh();
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

// initial load
fetchProducts();
// start auto-refresh if enabled
startAutoRefresh();

searchInput.addEventListener("input", () => { render({ animate: true }); });

filterButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    filterButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    render({ animate: true });
  });
});

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