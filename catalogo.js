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
    render({ animate: true });
    updateLastUpdated();
  } catch (err) {
    console.error('Error cargando productos desde backend:', err);
    showMessage('No se pudieron cargar productos desde el backend. Usando catálogo local si está disponible. ⚠️', 'warning');
    try {
      const local = await (await fetch('products.json')).json();
      products = local.map(normalize);
      render({ animate: true });
      updateLastUpdated(true);
    } catch (e) {
      showMessage('No hay productos disponibles', 'error');
    }
  }
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
    card.innerHTML = `
      <div class="product-image">
        <div class="price-badge">$${Number(p.precio).toFixed(2)}</div>
        <img src="${imgSrc}" alt="${escapeHtml(p.nombre)}" loading="lazy" fetchpriority="low">
      </div>
      <div class="product-info">
        <h3>${escapeHtml(p.nombre)}</h3>
        <p>${escapeHtml(p.descripcion)}</p>
        <div class="price">$${Number(p.precio).toFixed(2)}</div>
      </div>`;

    // post-render image handling: detect aspect ratio, fade-in, error fallback, lightbox trigger
    const temp = document.createElement('div');
    temp.appendChild(card);
    const img = temp.querySelector('img');

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

    // accessible interactions (click / keyboard)
    card.addEventListener('click', (ev) => {
      const src = img.getAttribute('src');
      openLightbox(src, p.nombre, p.descripcion);
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

function addToCart(productId, qty = 1){ const cart = readCart(); const idx = cart.findIndex(i=>i.id===productId); if(idx>=0){ cart[idx].qty = Math.min(99, cart[idx].qty + qty); } else { const p = products.find(x => String(x.id ?? x._id) === String(productId)); cart.push({ id: String(productId), qty: Math.min(99, qty), meta: { name: p?.nombre || p?.name || '', price: p?.precio ?? p?.price ?? 0, image: p?.imagen || p?.image || p?.image_url || '' } }); }
  writeCart(cart); renderCart(); pulseCard(productId);
}
function setCartItem(productId, qty){ const cart = readCart(); const idx = cart.findIndex(i=>i.id===productId); if(idx>=0){ if(qty<=0) cart.splice(idx,1); else cart[idx].qty = Math.min(99, qty); writeCart(cart); renderCart(); } }
function removeFromCart(productId){ const cart = readCart().filter(i=>i.id!==productId); writeCart(cart); renderCart(); }
function clearCart(){ writeCart([]); renderCart(); }

function pulseCard(productId){ const sel = `[data-pid="${productId}"]`; const card = document.querySelector(sel); if(!card) return; card.classList.add('added'); setTimeout(()=>card.classList.remove('added'), 600); }

function renderCart(){ const container = document.getElementById('cartItems'); const subtotalEl = document.getElementById('cartSubtotal'); const cart = readCart(); container.innerHTML = '';
  if(cart.length===0){ container.innerHTML = '<div class="cart-empty">Tu carrito está vacío</div>'; subtotalEl.textContent = '$0.00'; updateCartBadge(); return; }
  let subtotal = 0; cart.forEach(item=>{ const row = document.createElement('div'); row.className = 'cart-item'; row.dataset.pid = item.id; const img = document.createElement('div'); img.className = 'ci-image'; img.innerHTML = `<img src="${item.meta?.image || 'images/placeholder.png'}" alt="${escapeHtml(item.meta?.name||'')}">`; const info = document.createElement('div'); info.className = 'ci-info'; info.innerHTML = `<div class="ci-name">${escapeHtml(item.meta?.name||'')}</div><div class="ci-price">$${Number(item.meta?.price||0).toFixed(2)}</div>`;
    const controls = document.createElement('div'); controls.className = 'ci-controls'; controls.innerHTML = `<div class="qty" role="group" aria-label="Cantidad"><button class="qty-dec" aria-label="Disminuir">−</button><div class="val" aria-live="polite">${item.qty}</div><button class="qty-inc" aria-label="Aumentar">+</button></div><button class="btn btn-ghost remove">Eliminar</button>`;
    row.appendChild(img); row.appendChild(info); row.appendChild(controls); container.appendChild(row);
    subtotal += (item.meta?.price||0) * item.qty;
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
  document.addEventListener('click',(ev)=>{ const add = ev.target.closest && ev.target.closest('.btn-add'); if(add){ ev.preventDefault(); ev.stopPropagation(); const id = add.dataset.id; addToCart(String(id), 1); openCart(String(id)); return; } });
  const fab = document.getElementById('cartButton'); if(fab) fab.addEventListener('click', ()=>{ const drawer = document.getElementById('cartDrawer'); if(drawer.getAttribute('aria-hidden')==='true') openCart(); else closeCart(); });
  const closeBtn = document.getElementById('closeCart'); if(closeBtn) closeBtn.addEventListener('click', closeCart);
  const clearBtn = document.getElementById('clearCart'); if(clearBtn) clearBtn.addEventListener('click', ()=>{ if(confirm('Vaciar el carrito?')) clearCart(); });
  const checkout = document.getElementById('checkoutBtn'); if(checkout) checkout.addEventListener('click', ()=> alert('Checkout demo — integrar pasarela real.'));
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