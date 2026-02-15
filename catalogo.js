// API: prefer the real endpoint but tolerate variations (English/Spanish)
const API_URL = "https://backend-0lcs.onrender.com";
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

// Units / kg options
const KG_OPTIONS = [
  { value: 1, label: '1' },
  { value: 0.5, label: '1/2' },
  { value: 1/3, label: '1/3' },
  { value: 0.25, label: '1/4' }
];

function normalizeSaleUnit(val){
  const v = String(val || '').trim().toLowerCase();
  if (v === 'kg' || v === 'kilo' || v === 'kilos' || v === 'kilogram' || v === 'kilograms' || v === 'kilogramo' || v === 'kilogramos') return 'kg';
  return 'unit';
}

function getSaleUnitFromObj(obj){
  try{
    return normalizeSaleUnit(obj?.sale_unit || obj?.unit_type || obj?.unit || obj?.unidad_venta || obj?.saleUnit || obj?.tipo_venta);
  }catch(_){ return 'unit'; }
}

function getKgPerUnitFromObj(obj){
  try{
    const n = Number(obj?.kg_per_unit ?? obj?.kgPerUnit ?? obj?.peso_unidad ?? obj?.unidad_kg ?? obj?.kgXUnidad ?? 1);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }catch(_){ return 1; }
}

function getStockKgFromObj(obj){
  try{
    const stockKg = Number(obj?.stock_kg ?? obj?.stockKg);
    const fallback = Number(obj?.stock ?? obj?.cantidad ?? 0);
    if (Number.isFinite(stockKg) && stockKg > 0) return stockKg;
    if ((!Number.isFinite(stockKg) || stockKg <= 0) && Number.isFinite(fallback) && fallback > 0) return fallback;
    if (Number.isFinite(stockKg)) return Math.max(0, stockKg);
    return Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
  }catch(_){ return 0; }
}

function getOrderedWeightKg(qtyFraction, kgPerUnit){
  try{
    const q = Number(qtyFraction);
    const k = Number(kgPerUnit);
    if (!Number.isFinite(q) || !Number.isFinite(k) || k <= 0) return 0;
    return Math.max(0, q * k);
  }catch(_){ return 0; }
}

function formatKgLabel(qty){
  try{
    const num = Number(qty);
    if (Number.isNaN(num)) return String(qty || '');
    const match = KG_OPTIONS.find(o => Math.abs(o.value - num) < 0.0001);
    if (match) return match.label;
    return String(parseFloat(num.toFixed(3)));
  }catch(_){ return String(qty || ''); }
}

function formatQtyLabel(qty, unitType, meta){
  const unit = normalizeSaleUnit(unitType);
  if (unit === 'kg'){
    if (meta && meta.qty_label) return String(meta.qty_label);
    return formatKgLabel(qty);
  }
  return String(qty);
}

// promotions support
let promotions = [];
// consumos (admin-managed immediate-consumption discounts)
let consumos = [];
// helper: infer consumo type when admin data doesn't include `type`
function getConsumoType(c){
  if (!c) return null;
  if (c.type) return c.type;
  if (c.discount != null) return 'percent';
  return null;
}

async function fetchConsumos(){
  const tryUrls = [
    '/api/consumos',
    '/consumos',
    `${API_ORIGIN}/api/consumos`,
    `${API_ORIGIN}/consumos`,
    'consumos.json'
  ];
  for (const url of tryUrls){
    try{
      const res = await fetch(url, { cache: 'no-store' });
      if(!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data)) { consumos = data; return consumos; }
      // tolerate wrapped responses
      if (data && Array.isArray(data.consumos)) { consumos = data.consumos; return consumos; }
    }catch(e){ /* try next */ }
  }
  consumos = [];
  return consumos;
}

async function fetchPromotions(){
  const tryUrls = [
    '/api/promos',
    '/promotions',
    '/promociones',
    `${API_ORIGIN}/api/promos`,
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

// Listen for consumos updates from admin (optional live-refresh)
try{
  if (typeof BroadcastChannel !== 'undefined'){
    const bcCons = new BroadcastChannel('consumos_channel');
    bcCons.onmessage = (ev) => {
      try{
        if (!ev.data) return;
        if (ev.data.action === 'consumos-updated'){
          // admin may post { action: 'consumos-updated', consumos }
          if (Array.isArray(ev.data.consumos)) consumos = ev.data.consumos;
          else fetchConsumos().then(()=>{ try{ render({ animate: true }); }catch(_){} });
          try{ render({ animate: true }); }catch(_){}
        }
      }catch(e){}
    };
  }
}catch(e){/* ignore */}

// Listen for admin-managed filters (key: 'admin_filters_v1') via BroadcastChannel 'filters_channel'
function loadAdminFilters(){
  try{ const raw = localStorage.getItem('admin_filters_v1') || '[]'; const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; }catch(e){ return []; }
}

// Product categories mapping (productKey -> [filterValue,...])
function loadProductCategories(){
  try{ const raw = localStorage.getItem('admin_product_categories_v1') || '{}'; const parsed = JSON.parse(raw); return (parsed && typeof parsed === 'object') ? parsed : {}; }catch(e){ return {}; }
}

async function fetchAndSyncProductCategories(){
  const tryUrls = ['/product-categories.json', `/admin/product-categories.json`, `${API_ORIGIN}/product-categories.json`, `${API_ORIGIN}/product-categories`];
  for(const url of tryUrls){
    try{
      console.debug('[catalogo] fetchAndSyncProductCategories: trying', url);
      const res = await fetch(url, { cache: 'no-store' });
      if(!res.ok){ console.debug('[catalogo] fetchAndSyncProductCategories: non-ok response from', url, res.status); continue; }
      const data = await res.json();
      if(data && typeof data === 'object'){
        try{ localStorage.setItem('admin_product_categories_v1', JSON.stringify(data)); }catch(e){ console.warn('[catalogo] fetchAndSyncProductCategories: failed to write localStorage', e); }
        try{ render({ animate: true }); }catch(e){}
        console.log('[catalogo] fetched product-categories from', url);
        return;
      } else {
        console.debug('[catalogo] fetchAndSyncProductCategories: no mapping at', url);
      }
    }catch(e){ console.debug('[catalogo] fetchAndSyncProductCategories: fetch error for', url, e); /* ignore and try next */ }
  }
  console.debug('[catalogo] fetchAndSyncProductCategories: no mapping found in any tryUrls');
}

// Try to fetch filters from common locations (so catalog shows them even when admin runs on a different origin)
async function fetchAndSyncFilters(){
  const tryUrls = ['/filters.json','/admin/filters.json','/filters', `${API_ORIGIN}/filters.json`, `${API_ORIGIN}/filters`, `${API_ORIGIN}/admin/filters`];
  for(const url of tryUrls){
    try{
      console.debug('[catalogo] fetchAndSyncFilters: trying', url);
      const res = await fetch(url, { cache: 'no-store' });
      if(!res.ok){ console.debug('[catalogo] fetchAndSyncFilters: non-ok response from', url, res.status); continue; }
      const data = await res.json();
      if(Array.isArray(data) && data.length){
        console.debug('[catalogo] fetchAndSyncFilters: got', data.length, 'filters from', url);
        try{ localStorage.setItem('admin_filters_v1', JSON.stringify(data)); }catch(e){ console.warn('[catalogo] fetchAndSyncFilters: failed to write localStorage', e); }
        try{ renderFilterButtons(); }catch(e){ console.warn('[catalogo] fetchAndSyncFilters: renderFilterButtons failed', e); }
        console.log('[catalogo] fetched filters from', url);
        return data;
      } else {
        console.debug('[catalogo] fetchAndSyncFilters: no filters at', url);
      }
    }catch(e){ console.debug('[catalogo] fetchAndSyncFilters: fetch error for', url, e); /* ignore and try next */ }
  }
  console.debug('[catalogo] fetchAndSyncFilters: no filters found in any tryUrls');
  // fallback to local storage cached copy (if any)
  try{
    const cached = JSON.parse(localStorage.getItem('admin_filters_v1') || '[]');
    if (Array.isArray(cached) && cached.length) return cached;
  }catch(e){ /* ignore */ }
  return [];
} 

function renderFilterButtons(){
  try{
    const container = document.querySelector('.filters');
    if(!container){
      console.debug('[catalogo] renderFilterButtons: .filters not found yet, retrying...');
      // try again shortly (protect against scripts running before the DOM piece exists)
      setTimeout(renderFilterButtons, 200);
      return;
    }
    const filters = loadAdminFilters();
    console.debug('[catalogo] renderFilterButtons: found container, filtersCount=', (filters||[]).length);
    container.innerHTML = '';

    // active filters (selected to filter products). Keep UI buttons always visible; modal controls selection
    const active = loadActiveFilters();

    const allBtn = document.createElement('button'); allBtn.dataset.filter = 'all'; allBtn.textContent = 'Todos';
    allBtn.addEventListener('click', ()=>{ currentFilter = 'all'; saveActiveFilters([]); render({ animate: true }); Array.from(container.querySelectorAll('button')).forEach(b=>b.classList.remove('active')); allBtn.classList.add('active'); });
    container.appendChild(allBtn);

    // Manage filters button (opens modal to choose which filters to apply)
    const manageBtn = document.createElement('button');
    manageBtn.className = '__manage_filters_btn btn btn-outline';
    manageBtn.type = 'button';
    manageBtn.setAttribute('aria-haspopup','dialog');
    const activeCount = (active && active.length) ? active.length : 0;
    manageBtn.innerHTML = `Ver filtros <span class="__manage_count" aria-hidden="true">${activeCount}</span>`;
    manageBtn.title = 'Administrar filtros';
    manageBtn.addEventListener('click', ()=>{ showFilterManagerModal(); });
    container.appendChild(manageBtn);

    // compute full list of filters: admin filters or fallbacks
    const allFilters = (filters && filters.length) ? filters.map(f => ({ value: String(f.value || f.name || '').toLowerCase(), name: String(f.name || f.value || '') })) : [{v:'lacteos', t:'Lácteos'},{v:'fiambres', t:'Fiambres'},{v:'complementos', t:'Complementos'}].map(d=>({ value: d.v, name: d.t }));

    // Always show every admin filter button; active filters control highlighting and data filtering.
    const activeFilters = loadActiveFilters();
    const seen = new Set();
    const listToShow = [];
    for (const f of (allFilters || [])) {
      const value = String(f.value || '').toLowerCase();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      listToShow.push({ value, name: String(f.name || f.value || value) });
    }

    for(const f of listToShow){
      try{
        const b = document.createElement('button');
        b.dataset.filter = f.value || String(f.name || '').toLowerCase();
        b.textContent = f.name || f.value;
        b.addEventListener('click', ()=>{ currentFilter = b.dataset.filter; saveActiveFilters([String(b.dataset.filter).toLowerCase()]); render({ animate: true }); Array.from(container.querySelectorAll('button')).forEach(x=>x.classList.remove('active')); b.classList.add('active'); });
        // mark active if currentFilter matches
        const val = (b.dataset.filter || '').toLowerCase();
        if ((currentFilter && currentFilter.toLowerCase() === val) || (activeFilters || []).includes(val)){ b.classList.add('active'); allBtn.classList.remove('active'); }
        container.appendChild(b);
      }catch(e){ console.warn('[catalogo] renderFilterButtons: failed creating button for filter', f, e); }
    }

    // mark 'Todos' active when there is no specific current filter and there are no active filters
    const _act = loadActiveFilters();
    if((!currentFilter || currentFilter === 'all') && !(_act && _act.length)){
      Array.from(container.querySelectorAll('button')).forEach(x=>x.classList.remove('active'));
      allBtn.classList.add('active');
    }

    // small responsive hint for mobile: make manage button visible and easy to tap
    try{
      manageBtn.style.marginLeft = '8px';
      manageBtn.style.padding = '8px 10px';
      manageBtn.style.borderRadius = '10px';
      manageBtn.style.border = '1px solid rgba(0,0,0,0.06)';
      manageBtn.style.background = 'transparent';
      manageBtn.style.fontWeight = '700';
    }catch(_){ }
  }catch(e){ console.warn('renderFilterButtons failed', e); }
}

// active filters persistence helpers (which filters are applied when saving from modal)
function loadActiveFilters(){ try{ const raw = localStorage.getItem('catalog:active_filters_v1'); if(!raw) return []; const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.map(v=>String(v).toLowerCase()) : []; }catch(e){ return []; } }
function saveActiveFilters(arr){ try{ localStorage.setItem('catalog:active_filters_v1', JSON.stringify(Array.isArray(arr) ? arr.map(v=>String(v).toLowerCase()) : [])); }catch(e){} }

// Modal to manage which filters are visible (responsive + accessible)
async function showFilterManagerModal(){
  try{
    // ensure we have the latest filters from backend before showing
    try{ await fetchAndSyncFilters(); }catch(e){ /* ignore fetch errors, fallback to local */ }

    if(document.getElementById('__filters_modal')) return document.getElementById('__filters_modal').classList.add('open');
    const filters = loadAdminFilters();
    const defaults = [{v:'lacteos', t:'Lácteos'},{v:'fiambres', t:'Fiambres'},{v:'complementos', t:'Complementos'}];
    const all = (filters && filters.length) ? filters.map(f=>({ value: String(f.value||f.name||'').toLowerCase(), name: String(f.name||f.value||'') })) : defaults.map(d=>({ value: d.v, name: d.t }));
    const active = loadActiveFilters();

    const overlay = document.createElement('div'); overlay.id='__filters_modal'; overlay.className='filters-overlay';
    const itemsHtml = (function(){
      if (all.length) {
        return all.map(function(f){
          const checked = active.includes(String(f.value).toLowerCase()) ? 'checked' : '';
          return '<label class="f-item"><input type="checkbox" value="' + escapeHtml(f.value) + '" ' + checked + '><div style="flex:1">' + escapeHtml(f.name) + '</div></label>';
        }).join('');
      }
      return '<div style="color:var(--muted);padding:12px">No hay filtros disponibles desde el panel de administración.</div>';
    })();

    overlay.innerHTML = `
      <div class="filters-modal" role="dialog" aria-modal="true" aria-label="Administrar filtros">
        <header>
          <div style="display:flex;flex-direction:column">
            <h3 style="margin:0">Administrar filtros</h3>
            <div class="subtitle">Seleccioná uno o varios filtros para aplicar a la vista de productos.</div>
          </div>
          <button class="fm-close" aria-label="Cerrar">✕</button>
        </header>
        <div class="filters-list">
          ${itemsHtml}
        </div>
        <div class="filters-actions">
          <button class="btn fm-select-all">Seleccionar todo</button>
          <button class="btn btn-ghost fm-reset">Restaurar (ninguno)</button>
          <button class="btn btn-ghost fm-cancel">Cancelar</button>
          <button class="btn btn-primary fm-save">Aplicar</button>
        </div>
      </div>`;

    // inject improved, professional styles (scoped)
    if(!document.getElementById('__filters_modal_styles')){
      const ss = document.createElement('style'); ss.id='__filters_modal_styles'; ss.textContent = `
        .filters-overlay{ position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,0.45);backdrop-filter:blur(4px);z-index:2400;opacity:0;pointer-events:none;transition:opacity .22s ease}
        .filters-overlay.open{opacity:1;pointer-events:auto}
        .filters-modal{width:640px;max-width:calc(100% - 48px);background:linear-gradient(180deg, #fff, #fcfcfd);border-radius:12px;padding:18px;box-shadow:0 24px 64px rgba(3,10,40,0.12);border:1px solid rgba(10,34,64,0.06);color:var(--deep);transition:transform .18s ease;transform:translateY(0)}
        .filters-modal{display:flex;flex-direction:column;gap:12px}
        .filters-modal header{display:flex;align-items:center;justify-content:space-between}
        .filters-modal .subtitle{color:var(--muted);font-size:13px}
        .filters-list{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:6px 2px;margin:0}
        .filters-list .f-item{display:flex;align-items:center;gap:12px;padding:12px;border-radius:10px;border:1px solid rgba(6,26,43,0.04);background:linear-gradient(180deg,#fff,#fbfbfd);cursor:pointer}
        .filters-list .f-item:hover{box-shadow:0 8px 20px rgba(2,6,23,0.05);transform:translateY(-2px)}
        .filters-list input[type=checkbox]{accent-color:var(--accent);width:18px;height:18px}
        .filters-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}
        .filters-actions .btn{padding:10px 14px;border-radius:10px}
        .filters-actions .btn-ghost{background:transparent;border:1px solid rgba(10,34,64,0.06)}
        /* mobile bottom-sheet */
        @media(max-width:720px){ .filters-overlay{align-items:flex-end} .filters-modal{width:100%;height:56vh;max-width:none;border-radius:12px 12px 0 0;padding:18px;box-shadow:0 -18px 38px rgba(3,10,40,0.12);border-top:1px solid rgba(10,34,64,0.06);} .filters-list{grid-template-columns:repeat(1,1fr);max-height:42vh;overflow:auto} }
        /* manage button badge */
        .__manage_filters_btn{display:inline-flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid rgba(10,34,64,0.06);background:transparent}
        .__manage_filters_btn .__manage_count{background:var(--accent);color:#fff;padding:2px 8px;border-radius:999px;font-weight:700;font-size:12px}
      `; document.head.appendChild(ss);
    }

    document.body.appendChild(overlay);
    requestAnimationFrame(()=> overlay.classList.add('open'));

    // bindings
    const modal = overlay.querySelector('.filters-modal');
    overlay.querySelector('.fm-close').addEventListener('click', ()=> overlay.remove());
    overlay.querySelector('.fm-cancel').addEventListener('click', ()=> overlay.remove());
    overlay.querySelector('.fm-select-all').addEventListener('click', ()=>{ overlay.querySelectorAll('.filters-list input[type=checkbox]').forEach(i=>i.checked = true); });
    overlay.querySelector('.fm-reset').addEventListener('click', ()=>{ saveActiveFilters([]); overlay.querySelectorAll('.filters-list input[type=checkbox]').forEach(i=>i.checked = false); showToast('Configuración de filtros restaurada (ninguno seleccionado)'); if (overlay.querySelector('.fm-save')) overlay.querySelector('.fm-save').disabled = false; });

    overlay.querySelector('.fm-save').addEventListener('click', ()=>{
      try{
        const checked = Array.from(overlay.querySelectorAll('.filters-list input[type=checkbox]:checked')).map(i=>String(i.value).toLowerCase());
        saveActiveFilters(checked);
        // set currentFilter to the single selection for button highlighting if only one chosen
        currentFilter = (checked && checked.length === 1) ? checked[0] : 'all';
        renderFilterButtons();
        render({ animate: true });
        overlay.remove();
        showToast('Filtros aplicados', 2500);
      }catch(e){ console.warn('save filters failed', e); }
    });

    // if no filters, disable select/save actions
    if (!all.length) {
      try{ overlay.querySelector('.fm-select-all').disabled = true; overlay.querySelector('.fm-save').disabled = true; }catch(_){ }
    }

    // close on Esc
    const onKey = (ev)=>{ if (ev.key === 'Escape') { overlay.remove(); window.removeEventListener('keydown', onKey); } };
    window.addEventListener('keydown', onKey);

  }catch(e){ console.warn('showFilterManagerModal failed', e); }
} 
try{ if(typeof BroadcastChannel !== 'undefined'){ const bc2 = new BroadcastChannel('filters_channel'); bc2.onmessage = (ev) => { try{ if(ev.data && ev.data.action === 'filters-updated'){ console.log('[catalogo] filters updated via BroadcastChannel'); // fetch latest then refresh UI and modal if open
              fetchAndSyncFilters().then((data)=>{ try{ renderFilterButtons(); }catch(_){} try{ refreshFilterModalContents(); }catch(_){ } }).catch(()=>{ try{ renderFilterButtons(); }catch(_){ } }); } }catch(e){} };
    // also listen for product categories updates
    const bcpc = new BroadcastChannel('product_categories_channel'); bcpc.onmessage = (ev) => { try{ if(ev.data && ev.data.action === 'product-categories-updated'){ console.log('[catalogo] product-categories updated via BroadcastChannel'); fetchAndSyncProductCategories().then(()=> render({ animate: true })).catch(()=> render({ animate: true })); } }catch(e){} } } }catch(e){}

// Listen for direct localStorage changes from other tabs
window.addEventListener('storage', (ev)=>{ if(ev.key === 'admin_filters_v1'){ try{ renderFilterButtons(); }catch(e){} } });

// Poll once at start and periodically as a fallback for cross-origin cases
try{ fetchAndSyncFilters(); setInterval(fetchAndSyncFilters, 30000); }catch(e){}
// Poll product-categories as well
try{ fetchAndSyncProductCategories(); setInterval(fetchAndSyncProductCategories, 30000); }catch(e){}


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
  const saleUnit = getSaleUnitFromObj(p);
  let image = p.imagen || p.image || p.image_url || p.imageUrl || null;
  // Si la ruta es relativa (empieza por '/') no anteponer el origen remoto cuando los
  // datos proceden del `products.json` local — así los assets locales se resuelven correctamente
  if (image) {
    // Normalize local uploads path so it resolves correctly when the page
    // is served from `/frontend/` (dev server) or from site root.
    // If image refers to uploads, prefer absolute root `/uploads/...` so it
    // doesn't become relative to `/frontend/` and 404.
    try{
      const imgStr = String(image || '');
      if (!imgStr) image = imgStr;
      else if (imgStr.match(/^\/?uploads\//i)) {
        // ensure absolute root path
        image = '/' + imgStr.replace(/^\//, '');
      } else if (imgStr.startsWith('/') && productsSource === 'api') {
        image = API_ORIGIN + imgStr;
      } else if (imgStr.startsWith('/') && productsSource !== 'api') {
        // keep absolute root as-is (will point to project root)
        image = imgStr;
      } else {
        // leave as relative path for other assets
        image = imgStr;
      }
    }catch(e){ /* ignore normalization errors */ }
  }
  return {
    ...p,
    nombre: name,
    descripcion: description,
    categoria: category,
    precio: price,
    imagen: image,
    sale_unit: saleUnit,
    kg_per_unit: getKgPerUnitFromObj(p),
    stock_kg: getStockKgFromObj(p)
  };
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
            const unitSuffix = '';
            card.innerHTML = `
              <div class="product-image">
                <div class="price-badge">$${Number(p.precio || p.price || 0).toFixed(2)}${unitSuffix}</div>
                <img src="${p.imagen || 'images/placeholder.png'}" alt="${escapeHtml(p.nombre || p.name || '')}" loading="lazy">
              </div>
              <div class="product-info">
                <h3>${escapeHtml(p.nombre || p.name || '')}</h3>
                <p>${escapeHtml(p.descripcion || p.description || '')}</p>
                <div class="price">$${Number(p.precio || p.price || 0).toFixed(2)}${unitSuffix}</div>
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
  // quick probe: avoid long waits trying remote API when backend is down
  let backendLikelyUp = true;
  try {
    const probeUrl = (typeof API_ORIGIN === 'string' && API_ORIGIN) ? (API_ORIGIN + '/health') : '/health';
    const pr = await fetchWithTimeout(probeUrl, {}, 1200).catch(()=>null);
    backendLikelyUp = !!(pr && pr.ok);
  } catch (e) { backendLikelyUp = false; }
  // try multiple endpoints: prefer configured remote API when page is served from a different origin
  // (avoid triggering many 404s when the frontend is hosted as static site on another host)
  let tryUrls = [];
  try {
    const pageOrigin = (location && location.protocol && location.protocol.startsWith('http') && location.origin) ? location.origin : null;
    const apiOrigin = (typeof API_URL === 'string' && API_URL) ? (new URL(API_URL)).origin : null;
    // broaden attempted endpoints to common API paths (api, api/v1, spanish plural)
    if (pageOrigin && apiOrigin && pageOrigin !== apiOrigin) {
      if (backendLikelyUp) {
        tryUrls = [
          apiOrigin + '/products',
          apiOrigin + '/api/products',
          apiOrigin + '/api/v1/products',
          apiOrigin + '/productos',
          apiOrigin + '/api/productos',
          pageOrigin + '/products',
          '/products',
          'products.json'
        ];
      } else {
        // backend down - prefer same-origin and local copies
        tryUrls = [ pageOrigin + '/products', '/products', 'products.json' ];
      }
    } else {
      if (backendLikelyUp && apiOrigin) {
        tryUrls = [ '/products', apiOrigin + '/products', apiOrigin + '/api/products', apiOrigin + '/api/v1/products', 'products.json' ];
      } else {
        tryUrls = [ '/products', 'products.json' ];
      }
    }
  } catch (e) {
    tryUrls = ['/products', API_ORIGIN + '/products', API_ORIGIN + '/api/products', 'products.json'];
  }
  try{ console.debug('[catalogo] fetchProducts tryUrls:', tryUrls); }catch(_){ }
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
        await fetchConsumos();
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
      await fetchConsumos();
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
  await fetchConsumos();
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
  // inject out-of-stock styles once
  if (!document.getElementById('__oos_styles')){
    const s = document.createElement('style'); s.id = '__oos_styles'; s.textContent = `
      .product-card.out-of-stock{opacity:0.56;filter:grayscale(0.8);pointer-events:auto}
      .product-card .out-of-stock-note{color:var(--muted);font-weight:700;margin-top:8px}
      .product-card .btn.disabled{opacity:0.6;pointer-events:none}
    `; document.head.appendChild(s);
  }
  const search = (searchInput.value || '').toLowerCase();
  const productCatMap = loadProductCategories();
  const filtered = products.filter(p => {
    const matchesSearch =
      (p.nombre || '').toLowerCase().includes(search) ||
      (p.descripcion || '').toLowerCase().includes(search);
    const pid = String(p.id ?? p._id ?? p.nombre ?? p.name ?? '');

    // Normalize assigned categories (ensure array, trim & lowercase values)
    const assignedRaw = (productCatMap && (productCatMap[pid] || productCatMap[String(p.nombre)])) || [];
    // Accept arrays, comma-separated strings or index-keyed objects (robust normalization)
    let assignedArr = [];
    if (Array.isArray(assignedRaw)) {
      assignedArr = assignedRaw;
    } else if (typeof assignedRaw === 'string') {
      assignedArr = assignedRaw.split(',').map(s => s.trim()).filter(Boolean);
    } else if (assignedRaw && typeof assignedRaw === 'object') {
      assignedArr = Object.values(assignedRaw).flat().map(v => String(v || '').trim()).filter(Boolean);
    } else {
      assignedArr = [];
    }
    const assigned = assignedArr.map(v => String(v || '').trim().toLowerCase());

    // Support comma-separated categories in product.categoria (e.g. "lacteos, fiambres")
    const prodCats = (p.categoria || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    const activeFilters = loadActiveFilters();
    // If no active filters selected, treat as no filtering (show all). Otherwise match any selected filter.
    const matchesFilter = (!activeFilters || activeFilters.length === 0) || activeFilters.some(fv => ((assigned && assigned.includes(fv)) || prodCats.includes(fv)));
    return matchesSearch && matchesFilter;
  });

  // Sort so products with stock appear first (in-stock before out-of-stock), preserving relative order otherwise
  try{
    filtered.sort((a,b)=>{
      const aUnit = getSaleUnitFromObj(a);
      const bUnit = getSaleUnitFromObj(b);
      const aStock = (aUnit === 'kg') ? getStockKgFromObj(a) : Number(a.stock ?? a.cantidad ?? 0);
      const bStock = (bUnit === 'kg') ? getStockKgFromObj(b) : Number(b.stock ?? b.cantidad ?? 0);
      const sa = (aStock > 0) ? 0 : 1;
      const sb = (bStock > 0) ? 0 : 1;
      if(sa !== sb) return sa - sb;
      return 0;
    });
  }catch(e){ /* ignore sorting errors */ }

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

  /* Consumiciones inmediatas: show a dedicated section with a header and only admin-configured consumos */
  // Ensure section exists and insert before promotions so it's visible near the top
  let consumosSection = document.getElementById('consumosSection');
  if (!consumosSection) {
    consumosSection = document.createElement('section');
    consumosSection.id = 'consumosSection';
    consumosSection.className = 'consumos-section';
    consumosSection.innerHTML = '<div class="consumos-header"><h2 class="consumos-title">Consumos inmediatos <small id="consumosCount" class="consumos-sub"></small></h2></div><div class="consumos-grid" id="consumosGrid"></div>';
    try{
      if (promosRow && promosRow.parentNode) promosRow.parentNode.insertBefore(consumosSection, promosRow);
      else if (grid.parentNode) grid.parentNode.insertBefore(consumosSection, grid);
      else document.body.insertBefore(consumosSection, grid);
    }catch(e){ document.body.appendChild(consumosSection); }
  }

  // populate grid strictly from admin-configured consumos (do not fallback to per-product discounts here)
  try{
    const gridEl = document.getElementById('consumosGrid');
    gridEl.innerHTML = '';
    const hasConsumosArray = Array.isArray(consumos) && consumos.length;
    if (!hasConsumosArray) {
      // hide the section when there are no admin consumos
      consumosSection.style.display = 'none';
    } else {
      consumosSection.style.display = '';
      const cFrag = document.createDocumentFragment();
      const seenC = new Set();
      consumos.forEach(c => {
        try{
          const ids = Array.isArray(c.productIds) ? c.productIds.map(x => String(x)) : (c.productId ? [String(c.productId)] : (c.id ? [String(c.id)] : []));
          const match = products.find(p => {
            const pid = String(p.id ?? p._id ?? p.nombre ?? p.name ?? '');
            if (ids.length && ids.includes(pid)) return true;
            if (ids.length && ids.some(x => x.toLowerCase() === String(p.nombre || p.name || '').toLowerCase())) return true;
            return false;
          });
          if (!match || seenC.has(String(c.id || c.productId || match.id))) return;
          seenC.add(String(c.id || c.productId || match.id));

          const card = document.createElement('article');
          card.className = 'consumo-card reveal';
          const imgSrc = match.imagen || match.image || 'images/placeholder.png';
          const cType = getConsumoType(c);
          const rawLabel = (c.discount || c.value) ? (cType === 'percent' ? `-${Math.round(Number(c.discount || c.value))}%` : `$${Number(c.value || 0).toFixed(2)}`) : 'Consumo';
          const basePrice = Number(match.precio ?? match.price ?? 0) || 0;
          const unitSuffix = '';
          let discountedPrice = basePrice;
          try{
            if (c && (c.discount != null || c.value != null)) {
              if (cType === 'percent') discountedPrice = Math.max(0, +(basePrice * (1 - (Number(c.discount || c.value || 0) / 100))).toFixed(2));
              else if (c.value) discountedPrice = Number(c.value);
            }
          }catch(_){ }
          const avail = (c && c.qty != null) ? Number(c.qty || 0) : null;
          const qtyHtml = (avail != null) ? ('<div class="consumo-qty">Disponibles: ' + String(avail) + '</div>') : '';
          // show new/old price and explicit saving when discounted
          const saved = Math.max(0, +(Number(basePrice) - Number(discountedPrice)).toFixed(2));
          const savingHtml = (saved > 0) ? ('<div class="consumo-saving">Ahorra: <strong>$' + Number(saved).toFixed(2) + '</strong>' + (cType === 'percent' && (c.discount || c.value) ? ' (' + String(Math.round(Number(c.discount || c.value))) + '%)' : '') + '</div>') : '';
          const priceHtml = '<div class="consumo-price"><span class="price-new">$' + Number(discountedPrice).toFixed(2) + unitSuffix + '</span>' + (discountedPrice !== basePrice ? ' <span class="price-old">$' + Number(basePrice).toFixed(2) + unitSuffix + '</span>' : '') + savingHtml + ' ' + qtyHtml + '</div>';
          const btnHtml = (avail == null || avail > 0) ? `<button class="btn btn-primary consumo-add" data-pid="${escapeHtml(String((match.id ?? match._id) || match.name || ''))}">Agregar</button>` : `<button class="btn btn-disabled" disabled>Agotado</button>`;
          card.innerHTML = `
            <div class="consumo-badge">${escapeHtml(rawLabel)}</div>
            <div class="consumo-thumb"><img src="${imgSrc}" alt="${escapeHtml(match.nombre || match.name || '')}"></div>
            <div class="consumo-info">
              <h4>${escapeHtml(c.name || match.nombre || match.name || 'Consumo inmediato')}</h4>
              <p>${escapeHtml(c.description || match.descripcion || '')}</p>
              ${priceHtml}
              <div class="consumo-cta">${btnHtml}</div>
            </div>`;
          cFrag.appendChild(card);
        }catch(e){ /* ignore */ }
      });
      gridEl.appendChild(cFrag);

      // update count indicator
      try{ const countEl = document.getElementById('consumosCount'); if (countEl) countEl.textContent = ' ' + String(consumos.length) + ' producto' + (consumos.length === 1 ? '' : 's'); }catch(_){ }

      // wire buttons
      try{
        gridEl.querySelectorAll('.consumo-add').forEach(btn => {
          btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            const pid = btn.getAttribute('data-pid');
            if (!pid) return;
            const card = btn.closest && btn.closest('article');
            const img = card && card.querySelector('img');
            // find consumo config for this pid
            let cobj = (Array.isArray(consumos) && consumos.length) ? consumos.find(x => {
              const ids = Array.isArray(x.productIds) ? x.productIds.map(String) : (x.productId ? [String(x.productId)] : (x.id ? [String(x.id)] : []));
              const pidStr = String(pid);
              if (ids && ids.includes(pidStr)) return true;
              return false;
            }) : null;
            let discountedPrice = null;
            try {
              const prod = products.find(p => String(p.id ?? p._id) === String(pid));
              const base = prod ? Number(prod.precio ?? prod.price ?? 0) : 0;
              if (cobj) {
                const cType = getConsumoType(cobj);
                if (cType === 'percent') discountedPrice = Math.max(0, +(base * (1 - (Number(cobj.discount || cobj.value || 0) / 100))).toFixed(2));
                else if (cobj.value) discountedPrice = Number(cobj.value);
              }
              if (discountedPrice === null) discountedPrice = base;
            }catch(_){ discountedPrice = null; }
            const available = cobj ? Number(cobj.qty || 0) : null;
            if (available !== null && available <= 0) { showAlert('Este consumo está agotado', 'error'); return; }
            try{ 
              // Use quantity selector so consumos can be added properly to cart
              if (typeof showQuantitySelector === 'function') {
                showQuantitySelector(String(pid), img || null);
              } else {
                const cType = getConsumoType(cobj);
                const discountLabel = (cobj && (cobj.discount != null || cobj.value != null)) ? (cType === 'percent' ? '-' + String(Math.round(Number(cobj.discount || cobj.value || 0))) + '%' : '$' + Number(cobj.value || 0).toFixed(2)) : '';
                const savings = (typeof discountedPrice === 'number' && prod) ? Math.max(0, +(Number(prod.precio ?? prod.price ?? 0) - Number(discountedPrice)).toFixed(2)) : 0;
                const meta = { price: discountedPrice, consumo: !!cobj, consumo_id: cobj ? cobj.id : null, discount_label: discountLabel, discount_savings: savings, discount_type: cType, discount_value: cobj ? (cobj.discount || cobj.value) : null };
                addToCart(String(pid), 1, img || null, { meta }); openCart(); 
              }
            }catch(e){ }
          });
        });
      }catch(e){ /* ignore wiring errors */ }
    }
  }catch(e){ /* ignore consumos rendering errors */ }

  /* Catálogo: show a dedicated header with product count */
  let catalogSection = document.getElementById('catalogSection');
  if (!catalogSection) {
    catalogSection = document.createElement('section');
    catalogSection.id = 'catalogSection';
    catalogSection.className = 'catalog-section';
    catalogSection.innerHTML = '<div class="catalog-header"><h2 class="catalog-title">Catálogo <small id="catalogCount" class="catalog-sub"></small></h2></div><div class="catalog-grid-wrap" id="catalogGridWrap"></div>';
    try{
      if (grid && grid.parentNode) grid.parentNode.insertBefore(catalogSection, grid);
      else document.body.appendChild(catalogSection);
    }catch(e){ document.body.appendChild(catalogSection); }
  }
  try{
    const wrap = document.getElementById('catalogGridWrap');
    if (wrap && grid && grid.parentNode !== wrap) wrap.appendChild(grid);
  }catch(_){}
  try{
    const countEl = document.getElementById('catalogCount');
    if (countEl) countEl.textContent = ' ' + String(filtered.length) + ' producto' + (filtered.length === 1 ? '' : 's');
  }catch(_){}

  const mainProducts = filtered; // fallback: use full filtered list for now

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
  mainProducts.forEach((p, i) => {
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
    const saleUnit = getSaleUnitFromObj(p);
    const unitSuffix = '';
    const stockUnitLabel = (saleUnit === 'kg') ? ' kg' : '';
    card.dataset.pid = pid;
    const stockVal = (saleUnit === 'kg')
      ? getStockKgFromObj(p)
      : Number(p.stock ?? p.cantidad ?? 0);
    // subtract reserved consumos from display
    let reserved = 0;
    try{ if (Array.isArray(consumos) && consumos.length) {
      const cc = consumos.find(c => {
        const ids = Array.isArray(c.productIds) ? c.productIds.map(String) : (c.productId ? [String(c.productId)] : (c.id ? [String(c.id)] : []));
        const pidStr = String(p.id ?? p._id ?? p.nombre ?? p.name ?? '');
        if (ids && ids.includes(pidStr)) return true;
        try{ if (ids && ids.some(id => id.toLowerCase() === String(p.nombre || p.name || '').toLowerCase())) return true; }catch(_){ }
        return false;
      });
      if (cc) reserved = Number(cc.qty || 0);
    }}catch(_){ }
    const displayStock = (saleUnit === 'kg')
      ? Math.max(0, Number(stockVal || 0))
      : Math.max(0, (Number(stockVal || 0) - Number(reserved || 0)));
    const outOfStock = Number.isNaN(displayStock) ? false : (displayStock <= 0);
    if (outOfStock) {
      card.classList.add('out-of-stock');
      card.setAttribute('aria-label', `${p.nombre || 'producto'} — sin stock`);
    }

    // check promotion for this product
    const promo = getBestPromotionForProduct(p);
    // find per-product discount if present on the product object
    let perProductDiscount = null;
    try{ const d = Number(p.discount ?? p.descuento ?? 0); if(!Number.isNaN(d) && d > 0) perProductDiscount = d; }catch(_){ perProductDiscount = null; }

    // Honor per-product discount or admin-configured consumos for product cards. Prefer admin consumos when present.
    let validConsumo = null;
    const basePrice = Number(p.precio ?? p.price ?? 0);

    // Only per-product discounts apply to product cards. Admin-configured consumos are shown in the "Consumos inmediatos" section only
    try{
      if (perProductDiscount != null){
        validConsumo = { id: p.id ?? p._id ?? p.nombre ?? p.name, discount: perProductDiscount, value: null };
      } else {
        validConsumo = null;
      }
    }catch(_){ validConsumo = null; }

    const discountedPromo = promo ? getDiscountedPrice(basePrice, promo) : null;
    let discountedConsumo = null;
    try{
      if (validConsumo){
        if (validConsumo.value != null && !Number.isNaN(Number(validConsumo.value))){
          discountedConsumo = Number(validConsumo.value);
        } else if (validConsumo.discount != null && !Number.isNaN(Number(validConsumo.discount))){
          discountedConsumo = Math.max(0, +(basePrice * (1 - (Number(validConsumo.discount) / 100))).toFixed(2));
        }
      }
    }catch(_){ discountedConsumo = null; }

    // choose the best (lowest) final price for the customer when multiple discounts exist
    let discounted = null;
    if (discountedPromo !== null && discountedConsumo !== null) discounted = Math.min(discountedPromo, discountedConsumo);
    else discounted = discountedPromo !== null ? discountedPromo : discountedConsumo;

    // Sync cart items for this product (non-consumo) so the cart always reflects current discounts
    try{
      if (discounted != null) {
        const cart = readCart();
        let changed = false;
        for (let ci of cart) {
          if (String(ci.id) === String(pid) && !(ci.meta && ci.meta.consumo)) {
            const current = Number(ci.meta && ci.meta.price != null ? ci.meta.price : (ci.meta && ci.meta.price === 0 ? 0 : null));
            if (Number.isFinite(current) ? Number(current) !== Number(discounted) : true) {
              if (!ci.meta) ci.meta = {};
              ci.meta.price = Number(discounted);
              changed = true;
            }
          }
        }
        if (changed) { try{ writeCart(cart); }catch(_){ } }
      }
    }catch(_){ }

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

    // product categories assigned by admin
    const pid2 = pid;
    const assignedCats = (productCatMap && (productCatMap[pid2] || productCatMap[String(p.nombre)])) || [];
    let catsHtml = '';
    if (assignedCats && assignedCats.length) {
      const spans = assignedCats.map(function(c){ return '<span class="pc-tag">' + escapeHtml(c) + '</span>'; }).join(' ');
      catsHtml = '<div class="product-meta">' + spans + '</div>';
    }

    // Show ribbon for validConsumo: percent as '-N%' or absolute value as '$N'
    let consumoRibbon = '';
    try{
      if (validConsumo){
        if (validConsumo.discount != null) consumoRibbon = `-${Math.round(Number(validConsumo.discount))}%`;
        else if (validConsumo.value != null) consumoRibbon = `$${Number(validConsumo.value).toFixed(2)}`;
      }
    }catch(_){ consumoRibbon = ''; }

    // build card HTML using concatenation to avoid nested template literal parsing issues
    let html = '';
    html += '<div class="product-image">';
    html += (promo && promoRibbon) ? ('<div class="promo-ribbon">' + promoRibbon + '</div>') : '';
    html += validConsumo ? ('<div class="consumo-ribbon">' + escapeHtml(consumoRibbon) + '</div>') : '';
    html += '<div class="price-badge">' + (discounted ? ('<span class="price-new">$' + Number(discounted).toFixed(2) + unitSuffix + '</span><span class="price-old">$' + Number(p.precio).toFixed(2) + unitSuffix + '</span>') : ('$' + Number(p.precio).toFixed(2) + unitSuffix)) + '</div>'; 
    html += '<img src="' + (imgSrc) + '" alt="' + escapeHtml(p.nombre) + '" loading="lazy" fetchpriority="low">';
    html += '</div>';
    html += '<div class="product-info">';
    html += catsHtml || '';
    html += '<h3>' + escapeHtml(p.nombre) + (isNew ? ' <span class="new-badge">Nuevo</span>' : '') + '</h3>';
    html += '<p>' + escapeHtml(p.descripcion) + '</p>';
    html += '<div class="price">' + (discounted ? ('<span class="price-new">$' + Number(discounted).toFixed(2) + unitSuffix + '</span> <span class="price-old">$' + Number(p.precio).toFixed(2) + unitSuffix + '</span>') : ('$' + Number(p.precio).toFixed(2) + unitSuffix)) + '</div>';
    // show stock info (reflect admin panel stock)
    if (!Number.isNaN(stockVal)) {
      if (stockVal > 0) {
        const stockShown = (saleUnit === 'kg') ? String(parseFloat(Number(displayStock).toFixed(3))) : String(displayStock);
        html += '<div class="stock-info" style="color:#666;margin-top:6px">Stock: ' + stockShown + stockUnitLabel + '</div>';
      } else {
        html += '<div class="stock-info" style="color:#b86a00;margin-top:6px;font-weight:700">Sin stock</div>';
      }
    }
    if (outOfStock) {
      html += '<div class="card-actions"><button class="btn btn-add disabled" disabled data-id="' + pid + '" aria-label="Sin stock">Sin stock</button></div>';
      html += '<div class="out-of-stock-note">Sin stock</div>';
    } else {
      html += '<div class="card-actions"><button class="btn btn-add" data-id="' + pid + '" aria-label="Agregar ' + escapeHtml(p.nombre) + ' al carrito">Agregar</button></div>';
    }
    html += '</div>';
    card.innerHTML = html;
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
        // simplified fallback sequence to avoid complex nested expressions
        if (typeof API_ORIGIN === 'string' && img.src && img.src.startsWith(API_ORIGIN) && location.origin !== API_ORIGIN) {
          img.src = img.src.replace(API_ORIGIN, '');
          return;
        }
        if (img.src && img.src.startsWith('/')) {
          img.src = img.src.replace(/^\//, '');
          return;
        }
        if (img.src) {
          const parts = img.src.split('/');
          const name = parts[parts.length - 1];
          if (name) { img.src = 'uploads/' + name; return; }
        }
      } catch (err) { /* ignore */ }
      img.src = 'images/placeholder.png';
      img.classList.add('img-loaded');
    });

    // stop propagation on Add button and wire add-to-cart (prevents opening lightbox)
    if (addBtn) {
      addBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = addBtn.dataset.id;
        showQuantitySelector(String(id), img || null, { forceRegular: true });
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
// v2: kg prices are stored as "precio por unidad completa" (not per-kg)
const CART_KEY = 'catalog:cart_v2';

function getCartKey(item){ return String(item.id) + ((item.meta && item.meta.consumo) ? ':consumo' : ':regular'); }

function getProductKey(obj){ return String(obj.id ?? obj._id ?? obj.nombre ?? obj.name); }
function readCart(){ try{ return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }catch{ return []; } }
function writeCart(cart){ localStorage.setItem(CART_KEY, JSON.stringify(cart)); updateCartBadge(); }

function getItemUnitType(item, prod){
  return normalizeSaleUnit(item?.meta?.unit_type || item?.meta?.sale_unit || item?.meta?.unit || prod?.sale_unit || prod?.unit_type);
}

function getItemKgPerUnit(item, prod){
  try{
    const fromMeta = Number(item?.meta?.kg_per_unit);
    if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  }catch(_){}
  return getKgPerUnitFromObj(prod);
}

function getItemOrderedWeightKg(item, prod){
  try{
    const explicit = Number(item?.meta?.ordered_weight_kg);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
  }catch(_){}
  return getOrderedWeightKg(Number(item?.qty || 0), getItemKgPerUnit(item, prod));
}

function getItemPriceMode(item){
  try{
    const mode = String(item?.meta?.price_mode || '').trim().toLowerCase();
    return mode === 'per_kg' ? 'per_kg' : 'unit';
  }catch(_){
    return 'unit';
  }
}

function getItemLineFactor(item, prod){
  const unitType = getItemUnitType(item, prod);
  if (unitType !== 'kg') return Number(item?.qty || 0);
  return getItemPriceMode(item) === 'per_kg'
    ? getItemOrderedWeightKg(item, prod)
    : Number(item?.qty || 0);
}

function updateCartBadge(){
  const count = readCart().reduce((s,i)=>s+Number(i.qty || 0),0);
  const display = Number.isInteger(count) ? String(count) : String(Number(count).toFixed(2));
  const el = document.getElementById('cartCount');
  if(el) el.textContent = display;
  if(count>0){ el.classList.add('has-items'); el.animate?.([{ transform: 'scale(1)' },{ transform: 'scale(1.12)' },{ transform: 'scale(1)' }], { duration: 320 }); }
}

/* showQuantitySelector: minimal, scoped modal to choose quantity before adding to cart */
function showQuantitySelector(productId, sourceEl = null, opts = {}){
  try{
    // avoid duplicates
    const existing = document.getElementById('__qty_selector');
    if (existing) existing.remove();

    const prod = products.find(x => String(x.id ?? x._id) === String(productId));
    const title = prod ? (prod.nombre || prod.name || '') : (productId || 'Producto');
    const saleUnit = getSaleUnitFromObj(prod);
    const isKg = saleUnit === 'kg';
    const kgPerUnit = isKg ? getKgPerUnitFromObj(prod) : 1;
    let qty = 1;
    let qtyLabel = '1';

    const overlay = document.createElement('div');
    overlay.id = '__qty_selector';
    overlay.className = 'qty-overlay';
    const imgSrc = prod?.imagen || prod?.image || prod?.image_url || 'images/placeholder.png';
    const basePrice = Number(prod?.precio ?? prod?.price ?? 0) || 0;
    let unitPrice = basePrice;
    const forceRegular = !!(opts && opts.forceRegular);
    let consumoObj = null;
    try {
      if (!forceRegular) {
        consumoObj = (Array.isArray(consumos) && consumos.length) ? consumos.find(x => {
          const ids = Array.isArray(x.productIds) ? x.productIds.map(String) : (x.productId ? [String(x.productId)] : (x.id ? [String(x.id)] : []));
          return ids.includes(String(productId));
        }) : null;
      }
    } catch(_) { consumoObj = null; }
    try{
      if (consumoObj && (consumoObj.discount != null || consumoObj.value != null)) {
        const cType = getConsumoType(consumoObj);
        if (cType === 'percent') unitPrice = Math.max(0, +(basePrice * (1 - (Number(consumoObj.discount || consumoObj.value || 0) / 100))).toFixed(2));
        else if (consumoObj.value) unitPrice = Number(consumoObj.value);
      } else {
        // fallback: honor per-product discount if present
        const perDisc = Number(prod?.discount ?? prod?.descuento ?? 0);
        if (!Number.isNaN(perDisc) && perDisc > 0) unitPrice = Math.max(0, +(basePrice * (1 - perDisc / 100)).toFixed(2));
      }
    }catch(_){ }

    const stockVal = isKg ? getStockKgFromObj(prod) : Number(prod?.stock ?? prod?.cantidad ?? 0);
    if (!isNaN(stockVal) && stockVal <= 0) {
      showAlert('actualmente no contamos con stock de este articulo', 'error');
      return;
    }

    // kg options (filter by available stock if present)
    let kgOptions = KG_OPTIONS.slice();
    if (isKg && !Number.isNaN(stockVal) && stockVal > 0) {
      kgOptions = KG_OPTIONS.filter(o => getOrderedWeightKg(o.value, kgPerUnit) <= (stockVal + 0.0001));
      if (kgOptions.length === 0) {
        showAlert('actualmente no contamos con stock de este articulo', 'error');
        return;
      }
    }
    if (isKg) {
      qty = kgOptions[0].value;
      qtyLabel = kgOptions[0].label;
    }

    const controlsHtml = isKg ? `
        <div class="qb-kg-controls" role="group" aria-label="Seleccionar cantidad">
          <button type="button" class="qb-kg-btn qb-kg-dec" aria-label="Reducir cantidad">-</button>
          <div class="qb-kg-val" aria-live="polite">${escapeHtml(qtyLabel)}</div>
          <button type="button" class="qb-kg-btn qb-kg-inc" aria-label="Aumentar cantidad">+</button>
        </div>
      ` : `
        <div class="qb-controls">
          <button class="qb-dec" aria-label="Disminuir cantidad">-</button>
          <div class="qb-val" aria-live="polite">1</div>
          <button class="qb-inc" aria-label="Aumentar cantidad">+</button>
        </div>
      `;

    overlay.innerHTML = `
      <div class="qty-box" role="dialog" aria-modal="true" aria-label="Seleccionar cantidad">
        <div class="qb-top"><img class="qb-img" src="${imgSrc}" alt="${escapeHtml(String(title))}"></div>
        <div class="qb-head"><strong>${escapeHtml(String(title))}</strong></div>
        ${controlsHtml}
        <div class="qb-price">${isKg ? 'Precio unidad completa' : 'Precio unitario'}: $${Number(unitPrice).toFixed(2)}${consumoObj ? ' <small style="color:var(--muted);margin-left:8px">Consumo inmediato</small>' : ''}</div>
        ${isKg ? `<div class="qb-unit-weight">1 unidad = ${String(parseFloat(Number(kgPerUnit).toFixed(3)))} kg</div>` : ''}
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
        .qb-kg-controls{display:flex;align-items:center;gap:12px;background:linear-gradient(180deg,#fff,#fbfbfd);border:1px solid rgba(6,26,43,0.06);border-radius:999px;padding:6px 10px;box-shadow:0 10px 24px rgba(6,26,43,0.06)}
        .qb-kg-btn{width:40px;height:40px;border-radius:50%;border:1px solid rgba(6,26,43,0.08);background:#fff;font-size:20px;font-weight:800;color:var(--accent)}
        .qb-kg-btn:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(6,26,43,0.08)}
        .qb-kg-val{min-width:80px;text-align:center;font-weight:900;color:var(--deep);font-size:16px}
        .qb-unit-weight{font-size:13px;color:var(--muted);font-weight:700}
        .qb-actions{display:flex;gap:8px;justify-content:flex-end;width:100%}
      `; document.head.appendChild(s);
    }

    const valEl = overlay.querySelector('.qb-val');
    const inc = overlay.querySelector('.qb-inc');
    const dec = overlay.querySelector('.qb-dec');
    const confirm = overlay.querySelector('.qb-confirm');
    const cancel = overlay.querySelector('.qb-cancel');

    const totalEl = overlay.querySelector('.qb-total');
    function refresh() {
      if (valEl) valEl.textContent = isKg ? String(qtyLabel) : String(qty);
      const kgValEl = overlay.querySelector('.qb-kg-val');
      if (kgValEl && isKg) kgValEl.textContent = String(qtyLabel);
      try{
        const factor = qty;
        totalEl.textContent = `Total: $${Number(unitPrice * factor).toFixed(2)}`;
        totalEl.classList.add('pulse');
        setTimeout(()=> totalEl.classList.remove('pulse'), 220);
      }catch(_){}
    }
    if (!isKg) {
      inc.addEventListener('click', ()=>{ if (qty < 99) qty += 1; refresh(); });
      dec.addEventListener('click', ()=>{ if (qty > 1) qty -= 1; refresh(); });
    } else {
      let kgIndex = 0;
      try{
        const idx = kgOptions.findIndex(o => Math.abs(o.value - qty) < 0.0001);
        kgIndex = idx >= 0 ? idx : 0;
      }catch(_){ kgIndex = 0; }
      const kgInc = overlay.querySelector('.qb-kg-inc');
      const kgDec = overlay.querySelector('.qb-kg-dec');
      const setKg = (index) => {
        const safe = Math.max(0, Math.min(kgOptions.length - 1, index));
        kgIndex = safe;
        const opt = kgOptions[kgIndex];
        qty = opt.value;
        qtyLabel = opt.label || formatKgLabel(qty);
        refresh();
      };
      if (kgInc) kgInc.addEventListener('click', ()=>{ if (kgIndex > 0) setKg(kgIndex - 1); });
      if (kgDec) kgDec.addEventListener('click', ()=>{ if (kgIndex < kgOptions.length - 1) setKg(kgIndex + 1); });
    }
    cancel.addEventListener('click', ()=>{ overlay.remove(); });
    confirm.addEventListener('click', ()=>{
      try{
        const optsLocal = {};
        if (consumoObj) optsLocal.meta = { price: unitPrice, consumo: true, consumo_id: consumoObj.id };
        else optsLocal.meta = { price: unitPrice, force_regular: forceRegular };
        optsLocal.meta.unit_type = saleUnit;
        if (isKg) {
          const orderedWeight = getOrderedWeightKg(qty, kgPerUnit);
          optsLocal.meta.qty_label = qtyLabel;
          optsLocal.meta.kg_per_unit = kgPerUnit;
          optsLocal.meta.ordered_weight_kg = orderedWeight;
          optsLocal.meta.price_mode = 'unit';
        }
        addToCart(String(productId), qty, sourceEl, optsLocal);
        openCart(String(productId));
      }catch(e){console.error(e);}
      finally{ overlay.remove(); }
    });

    const onKey = (ev)=>{ if (ev.key === 'Escape') { overlay.remove(); window.removeEventListener('keydown', onKey); } if (ev.key === 'Enter') { confirm.click(); } };
    window.addEventListener('keydown', onKey);
    setTimeout(()=>{ confirm.focus(); }, 40);
  }catch(err){ console.error('showQuantitySelector', err); }
}

function addToCart(productId, qty = 1, sourceEl = null, opts = {}){
  const cart = readCart();
  const key = String(productId) + ((opts && opts.meta && opts.meta.consumo) ? ':consumo' : ':regular');
  const idx = cart.findIndex(i=> (i.key || getCartKey(i)) === key);
  const isPromoSummary = String(productId).startsWith('promo:');

  if (isPromoSummary && idx >= 0) {
    cart[idx].qty = Math.min(99, Number(cart[idx].qty || 0) + Number(qty || 0));
    writeCart(cart);
    renderCart();
    return;
  }

  if(idx>=0){
    const prod = products.find(x => String(x.id ?? x._id) === String(productId));
    const mergedMeta = Object.assign({}, cart[idx].meta || {}, (opts && opts.meta) ? opts.meta : {});
    const unitType = getItemUnitType({ qty: cart[idx].qty, meta: mergedMeta }, prod);
    const requestedQty = Math.max(0, Number(cart[idx].qty || 0) + Number(qty || 0));

    if (unitType === 'kg') {
      const kgPerUnit = getItemKgPerUnit({ qty: requestedQty, meta: mergedMeta }, prod);
      const requestedWeight = getOrderedWeightKg(requestedQty, kgPerUnit);
      const availableKg = getStockKgFromObj(prod);
      if (availableKg <= 0 || requestedWeight > (availableKg + 0.0001)) {
        showAlert('No hay suficiente stock disponible', 'error');
        return;
      }
      cart[idx].qty = Math.min(99, requestedQty);
      mergedMeta.unit_type = 'kg';
      mergedMeta.kg_per_unit = kgPerUnit;
      mergedMeta.ordered_weight_kg = getOrderedWeightKg(cart[idx].qty, kgPerUnit);
      mergedMeta.qty_label = formatKgLabel(cart[idx].qty);
      mergedMeta.price_mode = 'unit';
    } else {
      let available = Number(prod?.stock ?? prod?.cantidad ?? 0) || 0;
      try {
        if (mergedMeta && mergedMeta.consumo) {
          const cobj = (Array.isArray(consumos) && consumos.length) ? consumos.find(x => {
            const ids = Array.isArray(x.productIds) ? x.productIds.map(String) : (x.productId ? [String(x.productId)] : (x.id ? [String(x.id)] : []));
            return ids.includes(String(productId));
          }) : null;
          available = cobj ? Number(cobj.qty || 0) : 0;
        }
      }catch(_){ }
      if (available <= 0 || requestedQty > available) {
        showAlert('No hay suficiente stock disponible', 'error');
        return;
      }
      cart[idx].qty = Math.min(99, requestedQty);
    }

    cart[idx].meta = mergedMeta;
    cart[idx].key = key;
    writeCart(cart);
    renderCart();
    pulseCard(productId);
    return;
  }

  // Special handling for promo-summary items (id like 'promo:123')
  if (isPromoSummary){
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
      try{ document.getElementById('cartButton')?.animate?.([{ transform: 'scale(1)' },{ transform: 'scale(1.06)' },{ transform: 'scale(1)' }], { duration: 380 }); }catch(_){ }
      return;
    }
    return;
  }

  // Default single product add
  const p = products.find(x => String(x.id ?? x._id) === String(productId));
  if (!p) return; // avoid adding unknown ids
  const meta = { name: p?.nombre || p?.name || '', price: p?.precio ?? p?.price ?? 0, image: p?.imagen || p?.image || p?.image_url || '', unit_type: getSaleUnitFromObj(p) };
  if (opts && opts.meta) try{ Object.assign(meta, opts.meta); }catch(_){ }

  const unitType = getItemUnitType({ qty, meta }, p);
  if (unitType === 'kg') {
    const kgPerUnit = getItemKgPerUnit({ qty, meta }, p);
    const availableKg = getStockKgFromObj(p);
    const requestedWeight = getOrderedWeightKg(qty, kgPerUnit);
    if (availableKg <= 0 || requestedWeight > (availableKg + 0.0001)) {
      showAlert('No hay suficiente stock disponible', 'error');
      return;
    }
    if (!meta.qty_label) meta.qty_label = formatKgLabel(qty);
    meta.kg_per_unit = kgPerUnit;
    meta.ordered_weight_kg = requestedWeight;
    meta.price_mode = 'unit';
  } else {
    // Validate stock before adding (if consumo meta provided use consumo availability)
    let available = Number(p?.stock ?? p?.cantidad ?? 0) || 0;
    try {
      if (opts && opts.meta && opts.meta.consumo) {
        const cobj = (Array.isArray(consumos) && consumos.length) ? consumos.find(x => {
          const ids = Array.isArray(x.productIds) ? x.productIds.map(String) : (x.productId ? [String(x.productId)] : (x.id ? [String(x.id)] : []));
          return ids.includes(String(productId));
        }) : null;
        available = cobj ? Number(cobj.qty || 0) : 0;
      }
    }catch(_){ }
    if (available <= 0) { showAlert('actualmente no contamos con stock de este articulo', 'error'); return; }
    if (qty > available) { showAlert('No hay suficiente stock disponible (solo ' + String(available) + ' disponibles)', 'error'); return; }
  }

  cart.push({ id: String(productId), qty: Math.min(99, qty), meta, key: String(productId) + ((meta && meta.consumo) ? ':consumo' : ':regular') });
  writeCart(cart);
  renderCart();
  pulseCard(productId);
  // fly animation from the source image to cart
  if (sourceEl && !reduceMotion) animateFlyToCart(sourceEl);
}
function setCartItemByKey(itemKey, qty, opts = {}){
  const cart = readCart();
  const idx = cart.findIndex(i=> (i.key || getCartKey(i)) === String(itemKey));
  if(idx < 0) return;
  if(qty <= 0) {
    cart.splice(idx, 1);
    writeCart(cart); renderCart(); return;
  }

  const ci = cart[idx];
  const prod = products.find(x => String(x.id ?? x._id) === String(ci.id));
  const mergedMeta = Object.assign({}, ci.meta || {}, (opts && opts.meta) ? opts.meta : {});
  const unitType = getItemUnitType({ qty, meta: mergedMeta }, prod);

  if (unitType === 'kg') {
    const kgPerUnit = getItemKgPerUnit({ qty, meta: mergedMeta }, prod);
    const availableKg = getStockKgFromObj(prod);
    if (availableKg <= 0) {
      showAlert('actualmente no contamos con stock de este articulo', 'error');
      return;
    }
    let newQty = Number(qty || 0);
    const requestedWeight = getOrderedWeightKg(newQty, kgPerUnit);
    if (requestedWeight > (availableKg + 0.0001)) {
      newQty = availableKg / kgPerUnit;
      showAlert('Cantidad ajustada al stock disponible', 'info');
    }
    cart[idx].qty = Math.min(99, Math.max(0, newQty));
    mergedMeta.unit_type = 'kg';
    mergedMeta.kg_per_unit = kgPerUnit;
    mergedMeta.ordered_weight_kg = getOrderedWeightKg(cart[idx].qty, kgPerUnit);
    mergedMeta.qty_label = formatKgLabel(cart[idx].qty);
    mergedMeta.price_mode = 'unit';
  } else {
    let available = Number(prod?.stock ?? prod?.cantidad ?? 0) || 0;
    try{ if (ci && mergedMeta && mergedMeta.consumo) {
      const cobj = (Array.isArray(consumos) && consumos.length) ? consumos.find(x => {
        const ids = Array.isArray(x.productIds) ? x.productIds.map(String) : (x.productId ? [String(x.productId)] : (x.id ? [String(x.id)] : []));
        return ids.includes(String(ci.id));
      }) : null;
      available = cobj ? Number(cobj.qty || 0) : 0;
    }}catch(_){ }
    if (available <= 0) {
      showAlert('actualmente no contamos con stock de este articulo', 'error');
      return;
    }
    const newQty = Math.min(99, qty > available ? available : qty);
    if (newQty !== qty) showAlert('Cantidad ajustada al stock disponible (' + String(available) + ')', 'info');
    cart[idx].qty = newQty;
  }

  cart[idx].meta = mergedMeta;
  writeCart(cart); renderCart();
}
function removeFromCartByKey(itemKey){ const cart = readCart().filter(i=> (i.key || getCartKey(i)) !== String(itemKey)); writeCart(cart); renderCart(); }
function clearCart(){ writeCart([]); renderCart(); }

function pulseCard(productId){ const sel = `[data-pid="${productId}"]`; const card = document.querySelector(sel); if(!card) return; card.classList.add('added'); setTimeout(()=>card.classList.remove('added'), 600); }

function renderCart(){ const container = document.getElementById('cartItems'); const subtotalEl = document.getElementById('cartSubtotal'); const cart = readCart(); container.innerHTML = '';
  // inject cart styles once
  if (!document.getElementById('__cart_styles')){
    const s = document.createElement('style'); s.id = '__cart_styles'; s.textContent = `
      #cartDrawer .cart-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:26px;text-align:center;color:var(--muted)}
      .cart-empty .ce-cta{margin-top:8px}
      .cart-item{display:flex;gap:16px;align-items:center;padding:16px;border-radius:14px;background:linear-gradient(180deg,rgba(255,255,255,0.98),rgba(250,250,250,0.98));border:1px solid rgba(0,0,0,0.04);margin-bottom:14px;box-shadow:0 8px 24px rgba(2,6,23,0.05)}
      .ci-image img{width:112px;height:112px;border-radius:12px;object-fit:cover;box-shadow:0 8px 20px rgba(2,6,23,0.08)}
      .ci-info{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0}
      .ci-name{font-weight:800;color:var(--deep);font-size:15px;display:flex;align-items:baseline;flex-wrap:wrap;column-gap:8px;row-gap:4px}
      .ci-name-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:normal;line-height:1.2}
      .ci-badge{flex:0 0 auto;padding:2px 8px;border-radius:999px;background:#fef3e8;color:#b86a00;font-weight:800;font-size:11px;border:1px solid rgba(242,107,56,0.18);white-space:nowrap;line-height:1.2}
      .ci-sub{font-size:13px;color:var(--muted)}
      .ci-price{margin-top:8px}
      .ci-price .price-new{color:var(--accent);font-weight:900;font-size:16px}
      .ci-price .price-old{color:var(--muted);text-decoration:line-through;margin-left:8px;font-size:12px}
      .ci-controls{display:flex;gap:12px;align-items:center;margin-left:auto;flex:0 0 auto}
      .qty{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid rgba(0,0,0,0.06);padding:8px 10px;border-radius:999px}
      .qty-kg{padding:6px 10px}
      .qty-select{border:0;background:transparent;font-weight:800;color:var(--deep);padding:4px 6px}
      .qty button{border:0;background:transparent;color:var(--accent);font-weight:800;padding:6px;width:34px;height:34px;border-radius:50%;cursor:pointer}
      .qty .val{min-width:30px;text-align:center;font-weight:800;color:var(--deep)}
      .btn.remove{background:transparent;border:1px solid rgba(0,0,0,0.06);padding:8px 12px;border-radius:10px;color:var(--muted)}
      #cartSubtotal{display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid rgba(0,0,0,0.04);margin-top:14px;font-weight:900}
      #cartDrawer .cart-footer{display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:14px}
      #cartDrawer .cart-actions{display:flex;gap:8px}
      #clearCart,#checkoutBtn{border-radius:12px;padding:10px 14px}
      #clearCart{background:transparent;border:1px solid rgba(0,0,0,0.06)}
      #checkoutBtn{background:linear-gradient(90deg,var(--accent),var(--accent-2));color:#fff;border:0}
      @media(max-width:620px){ .ci-image img{width:88px;height:88px} }
      @media(max-width:420px){ .ci-image img{width:66px;height:66px} }
      /* Mobile full-screen drawer overrides */
      @media(max-width:640px){
        #cartDrawer{ left:0 !important; right:0 !important; top:0 !important; bottom:0 !important; width:100% !important; height:100% !important; max-width:none !important; border-radius:0 !important; padding:18px !important }
        #cartDrawer .cart-inner{display:flex;flex-direction:column;height:100%}
        #cartDrawer .cart-items{overflow:auto;flex:1;padding-right:6px;}
        #cartDrawer .cart-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:8px}
        #cartDrawer .cart-summary{position:sticky;bottom:0;background:linear-gradient(180deg, rgba(255,255,255,0.96), rgba(255,255,255,0.92));padding-top:12px;padding-bottom:12px;border-top:1px solid rgba(0,0,0,0.04)}
        #cartDrawer .cart-actions{flex-direction:column;gap:10px}
        #cartDrawer #checkoutBtn{width:100%}
        #cartDrawer #clearCart{width:100%}
        #cartDrawer .cart-actions .btn{padding:12px;border-radius:12px}
        #cartDrawer .cart-item{padding:12px;gap:12px}
        #cartDrawer .ci-image img{width:88px;height:88px}
      }
    `; document.head.appendChild(s);
  }

  if(cart.length===0){ container.innerHTML = `<div class="cart-empty"><div style="font-size:36px;opacity:0.9">🛒</div><div style="font-weight:800">Tu carrito está vacío</div><div style="color:var(--muted)">Agregá productos para comenzar</div><div class="ce-cta"><button class="btn btn-primary" onclick="closeCart()">Seguir comprando</button></div></div>`; subtotalEl.textContent = '$0.00'; updateCartBadge(); return; }

  let subtotal = 0; cart.forEach(item=>{
    const row = document.createElement('div'); row.className = 'cart-item'; row.dataset.pid = item.id; row.dataset.key = (item.key || getCartKey(item));
    const img = document.createElement('div'); img.className = 'ci-image'; img.innerHTML = `<img src="${item.meta?.image || 'images/placeholder.png'}" alt="${escapeHtml(item.meta?.name||'')}">`;
    const info = document.createElement('div'); info.className = 'ci-info';

    // prefer item.meta.price when provided; try to reconcile with current `consumos` (admin changes may occur after item entered)
    const prod = products.find(x => String(x.id ?? x._id) === String(item.id));
    const productBase = prod ? (prod.precio ?? prod.price ?? 0) : (item.meta?.price ?? 0);
    const promo = getBestPromotionForProduct(prod || item);

    // If a consumo config currently exists for this product, compute its discounted price and prefer that (this lets cart reflect admin changes even for pre-existing cart items)
    let unitPrice = null;
    try {
      const forceRegularItem = !!(item.meta && item.meta.force_regular);
      const cobj = (!forceRegularItem && Array.isArray(consumos) && consumos.length) ? consumos.find(x => {
        const ids = Array.isArray(x.productIds) ? x.productIds.map(String) : (x.productId ? [String(x.productId)] : (x.id ? [String(x.id)] : []));
        return ids.includes(String(item.id));
      }) : null;
      if (cobj) {
        let cPrice = Number(productBase || 0);
        if (cobj.discount != null || cobj.value != null) {
          const cType = getConsumoType(cobj);
          if (cType === 'percent') cPrice = Math.max(0, +(Number(productBase) * (1 - (Number(cobj.discount || cobj.value || 0) / 100))).toFixed(2));
          else if (cobj.value) cPrice = Number(cobj.value);
        }
        unitPrice = Number(cPrice);
        // persist meta so subsequent renders keep the right price
        if (!item.meta) item.meta = {};
        if (item.meta.price !== unitPrice || !item.meta.consumo) {
          item.meta.price = unitPrice; item.meta.consumo = true; try{ writeCart(cart); }catch(_){ }
        }
      }
    } catch(e){ /* ignore */ }

    if (unitPrice === null) {
      // fallback: prefer stored meta.price when present (non-consumo), otherwise promo or product base
      const livePriceBase = (item.meta && item.meta.price != null) ? Number(item.meta.price) : productBase;
      unitPrice = (item.meta && item.meta.consumo && item.meta.price != null) ? Number(item.meta.price) : (promo ? getDiscountedPrice(productBase, promo) : livePriceBase);
    }

    // build name and price HTML, support promo-summary items that include multiple products
    const isConsumo = !!(item.meta && item.meta.consumo) || String(item.key || getCartKey(item)).includes(':consumo');
    let nameHtml = `<div class="ci-name"><span class="ci-name-text">${escapeHtml(item.meta?.name||prod?.nombre||'')}</span>${isConsumo ? ' <span class="ci-badge">Consumo inmediato</span>' : ''}</div>`;
    if (item.meta && item.meta.consumo) {
      try{
        // show how much discount is applied (prefer metadata from when item was added)
        const saved = item.meta && (typeof item.meta.discount_savings === 'number') ? Number(item.meta.discount_savings) : Math.max(0, Number(productBase) - Number(unitPrice));
        const label = (item.meta && item.meta.discount_label) ? String(item.meta.discount_label) : null;
        if (saved > 0) {
          nameHtml += `<div class="ci-sub"><small style="color:#b86a00">Ahorra $${Number(saved).toFixed(2)}${label ? ' (' + escapeHtml(label) + ')' : ''}</small></div>`;
        }
      }catch(_){ }
    }
    if (Array.isArray(item.meta?.products) && item.meta.products.length) {
      const lines = item.meta.products.map(x => `${escapeHtml(x.name || x.id)} — $${Number(x.price || 0).toFixed(2)}`);
      nameHtml += `<div class="ci-sub">${lines.join('<br>')}</div>`;
    }

    const unitType = getItemUnitType(item, prod);
    const unitSuffix = (unitType === 'kg') ? ' / unidad' : '';
    let priceHtml = '';
    if (item.meta && item.meta.consumo) {
      priceHtml = `<span class="price-new">$${Number(unitPrice).toFixed(2)}${unitSuffix}</span> <span class="price-old">$${Number(productBase).toFixed(2)}${unitSuffix}</span>`;
    } else if (promo) {
      priceHtml = `<span class="price-new">$${Number(unitPrice).toFixed(2)}${unitSuffix}</span> <span class="price-old">$${Number(productBase).toFixed(2)}${unitSuffix}</span> <small style="color:var(--muted);margin-left:6px">(${escapeHtml(promo.name||'promo')})</small>`;
    } else {
      priceHtml = `<span class="price-new">$${Number(unitPrice).toFixed(2)}${unitSuffix}</span>`;
    }
    const qtyLabel = formatQtyLabel(item.qty, unitType, item.meta);
    if (unitType === 'kg') {
      const orderedWeight = getItemOrderedWeightKg(item, prod);
      const weightLabel = String(parseFloat(Number(orderedWeight || 0).toFixed(3)));
      nameHtml += `<div class="ci-sub">Peso: ${weightLabel} kg</div>`;
    }
    info.innerHTML = `${nameHtml}<div class="ci-price">${priceHtml}</div>`;

    const controls = document.createElement('div');
    controls.className = 'ci-controls';
    if (unitType === 'kg') {
      const currentQty = Number(item.qty);
      let optsList = KG_OPTIONS.slice();
      const hasMatch = optsList.some(o => Math.abs(Number(o.value) - currentQty) < 0.0001);
      if (!hasMatch && Number.isFinite(currentQty)) {
        optsList = [{ value: currentQty, label: formatKgLabel(currentQty) }].concat(optsList);
      }
      const optionsHtml = optsList.map(o => {
        const selected = Math.abs(Number(o.value) - currentQty) < 0.0001;
        return `<option value="${o.value}" ${selected ? 'selected' : ''}>${o.label}</option>`;
      }).join('');
      controls.innerHTML = `<div class="qty qty-kg" role="group" aria-label="Cantidad"><select class="qty-select" aria-label="Seleccionar cantidad">${optionsHtml}</select></div><button class="btn remove">Eliminar</button>`;
    } else {
      controls.innerHTML = `<div class="qty" role="group" aria-label="Cantidad"><button class="qty-dec" aria-label="Disminuir">-</button><div class="val" aria-live="polite">${qtyLabel}</div><button class="qty-inc" aria-label="Aumentar">+</button></div><button class="btn remove">Eliminar</button>`;
    }

    row.appendChild(img); row.appendChild(info); row.appendChild(controls); container.appendChild(row);
    const lineFactor = getItemLineFactor(item, prod);
    subtotal += Number(unitPrice || 0) * Number(lineFactor || 0);

    // bindings
    const itemKey = (item.key || getCartKey(item));
    if (unitType === 'kg') {
      const sel = controls.querySelector('.qty-select');
      if (sel) {
        sel.addEventListener('change', () => {
          const val = Number(sel.value);
          const opt = KG_OPTIONS.find(o => Math.abs(o.value - val) < 0.0001);
          const kgPerUnit = getItemKgPerUnit(item, prod);
          setCartItemByKey(itemKey, Number(val), { meta: { unit_type: 'kg', kg_per_unit: kgPerUnit, ordered_weight_kg: getOrderedWeightKg(Number(val), kgPerUnit), qty_label: (opt && opt.label) ? opt.label : formatKgLabel(val), price_mode: 'unit' } });
        });
      }
    } else {
      controls.querySelector('.qty-inc').addEventListener('click', ()=> setCartItemByKey(itemKey, Number(item.qty)+1));
      controls.querySelector('.qty-dec').addEventListener('click', ()=> setCartItemByKey(itemKey, Number(item.qty)-1));
    }
    controls.querySelector('.remove').addEventListener('click', ()=> removeFromCartByKey(itemKey));
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

  // move actions into footer area if present
  try{
    const footer = document.getElementById('cartFooter'); if(footer){ footer.innerHTML = `<div class="cart-footer"><div id="cartSubtotal">Subtotal</div><div class="cart-actions"><button id="clearCart" class="btn">Vaciar</button><button id="checkoutBtn" class="btn btn-primary">Hacer pedido</button></div></div>`; document.getElementById('cartSubtotal').innerHTML = `Subtotal: <strong>$${Number(subtotal).toFixed(2)}</strong>`; }
  }catch(e){ }

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
  const clearBtn = document.getElementById('clearCart'); if(clearBtn) clearBtn.addEventListener('click', async ()=>{ const ok = await showConfirm('Vaciar el carrito?'); if (ok) clearCart(); });
  const checkout = document.getElementById('checkoutBtn');
  if (checkout) {
    // ensure label matches requested copy
    checkout.textContent = checkout.textContent.trim() || 'Hacer pedido';
    checkout.setAttribute('aria-label', 'Hacer pedido');
    checkout.addEventListener('click', async () => {
        const cart = readCart();
        if (!cart || cart.length === 0) return showAlert('El carrito está vacío');
        const basePayload = { items: cart, total: cart.reduce((s, i) => {
          const prod = products.find(p => String(p.id ?? p._id) === String(i.id));
          const factor = getItemLineFactor(i, prod);
          return s + (Number(i.meta?.price || 0) * Number(factor || 0));
        }, 0) };

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
                const ok = await showConfirm('Tu perfil está incompleto (faltan: ' + missing.join(', ') + '). ¿Deseas continuar y enviar el pedido igualmente?');
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

        // Proceed — checkout button reference created later

        // If there's no user info attached (guest checkout), offer to login or collect minimal contact info
        if (!basePayload.user_full_name && !basePayload.user_email) {
          try {
            const wantLogin = await showConfirm('No estás logueado. ¿Iniciar sesión para adjuntar tus datos al pedido? (Aceptar = login, Cancelar = enviar como invitado)');
            if (wantLogin) { openAuthModal(); try{ checkout.disabled = false; }catch(_){ } return; }
            // Collect minimal guest details via modal
            const guestInfo = await showGuestModal();
            if (guestInfo) {
              if (guestInfo.name) basePayload.user_full_name = guestInfo.name;
              if (guestInfo.email) basePayload.user_email = guestInfo.email;
              if (guestInfo.barrio) basePayload.user_barrio = guestInfo.barrio;
              if (guestInfo.calle) basePayload.user_calle = guestInfo.calle;
              if (guestInfo.numero) basePayload.user_numeracion = guestInfo.numero;
            }
          } catch (e) { console.warn('guest info prompt failed', e); }
        }

        // Ensure items are sent as a clean JSON array of simple objects
        // and attach a token preview snapshot so the backend can persist contact info.
        const payload = Object.assign({}, basePayload);
        try{
          payload.items = (basePayload.items || []).map(it => {
            const id = (it && (it.id || it._id)) ? (it.id || it._id) : (it && it.id) ? it.id : '';
            const qty = Number(it.qty || 1);
            let meta = {};
            try{ meta = Object.assign({}, (it && it.meta) ? it.meta : {}); }catch(_){ meta = {}; }
            const key = String((it && it.key) || (meta && meta.key) || '');
            if (key) meta.key = key;
            if (!meta.force_regular && !meta.consumo && key.includes(':consumo')) meta.consumo = true;
            try{
              const prod = products.find(p => String(p.id ?? p._id) === String(id));
              const unitType = getItemUnitType({ qty, meta }, prod);
              if (unitType === 'kg') {
                const kgPerUnit = getItemKgPerUnit({ qty, meta }, prod);
                meta.unit_type = 'kg';
                meta.kg_per_unit = kgPerUnit;
                meta.ordered_weight_kg = getOrderedWeightKg(qty, kgPerUnit);
                if (!meta.qty_label) meta.qty_label = formatKgLabel(qty);
                if (!meta.price_mode) meta.price_mode = 'unit';
              }
            }catch(_){ }
            return { id, qty, meta };
          });
        }catch(e){ payload.items = basePayload.items || []; }
        try{
          // If logged-in, include a lightweight preview from the profile we fetched above
          if (basePayload.user_full_name || basePayload.user_email) {
            payload._token_preview = payload._token_preview || { name: basePayload.user_full_name || null, email: basePayload.user_email || null };
          }
        }catch(e){}
        // If the cart includes consumo items, mark the payload but DO NOT prompt the customer
        try{
          const hasConsumos = Array.isArray(payload.items) && payload.items.some(i => {
            try{
              if (i && i.meta && i.meta.consumo) return true;
              const key = String((i && i.meta && i.meta.key) || (i && i.key) || '');
              return key.includes(':consumo');
            }catch(_){ return false; }
          });
          if (hasConsumos) {
            payload.contains_consumos = true;
            // No user confirmation here: consumptions are processed server-side transparently
          }
        }catch(e){}

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
      try{ console.debug('[checkout] authToken present?', !!authToken, authToken ? ('***'+authToken.slice(-10)) : null, 'headers', baseHeaders); }catch(_){ }

      const _attemptErrors = [];
      for (const url of tryUrls) {
        try {
          const res = await fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify(payload), mode: 'cors' });
          if (!res.ok) { const txt = await res.text().catch(()=>null); _attemptErrors.push({ url, status: res.status, statusText: res.statusText, body: txt }); throw new Error(`status:${res.status}`); }
          succeeded = true;
          break;
        } catch (err) {
          console.warn('checkout attempt failed for', url, err);
          try{ _attemptErrors.push({ url, error: String(err) }); }catch(_){ }
          // try next url
        }
      }

      try {
        if (succeeded) {
          // confirm visually and clear
          await showAlert('Pedido enviado — el panel de administración recibirá la orden.');
          clearCart(); closeCart();
        } else {
          // graceful fallback: keep el carrito (NO WhatsApp), mostrar modal con opciones al usuario
          console.warn('Checkout failed — showing fallback modal and keeping cart locally.', _attemptErrors);
          try{ console.error('[checkout] attempts', _attemptErrors); }catch(_){ }
          // show modal and persist the failed payload so the user can retry later
          try{ showOrderModal(payload); saveFailedOrder(payload); }catch(e){ showOrderModal(payload); }
          try{ showToast('No se pudo enviar el pedido. Se guardó localmente para reintento.', 5000); }catch(_){ }
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
      const itemsHtml = (payload.items || []).map(i=>{
        const unitType = normalizeSaleUnit(i?.meta?.unit_type || i?.meta?.sale_unit || i?.meta?.unit);
        const qtyLabel = formatQtyLabel(i?.qty, unitType, i?.meta || {});
        return `<li style="margin:8px 0"><strong>${escapeHtml(String(i.meta?.name||i.id))}</strong> — ${escapeHtml(qtyLabel)} × $${Number(i.meta?.price||0).toFixed(2)}</li>`;
      }).join('');
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
        .order-modal-overlay{ position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,0.36);backdrop-filter:blur(3px);z-index:1400;opacity:0;pointer-events:none;transition:opacity .18s ease}
        .order-modal-overlay.open{opacity:1;pointer-events:auto}
        .order-modal{width:520px;max-width:calc(100% - 36px);background:linear-gradient(180deg, rgba(255,255,255,0.98), var(--surface));border-radius:14px;padding:18px;box-shadow:0 18px 48px rgba(2,6,23,0.12);border:1px solid rgba(10,34,64,0.04);color:var(--deep)}
        .order-modal header{display:flex;align-items:center;justify-content:space-between;gap:12px}
        .order-modal h3{margin:0;font-size:18px}
        .order-modal .om-close{background:transparent;border:0;color:var(--muted);font-size:18px;cursor:pointer}
        .order-modal .om-copy, .order-modal .om-download{background:transparent;border:1px solid rgba(0,0,0,0.06);padding:8px 12px;border-radius:10px}
        .order-modal .om-retry{padding:10px 14px;border-radius:10px;background:linear-gradient(90deg,var(--accent),var(--accent-2));color:#fff;border:0}
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
        if (ok) { modal.remove(); await showAlert('Pedido enviado — el panel de administración recibirá la orden.'); clearCart(); closeCart(); }
        else { await showAlert('No se pudo enviar la orden. Puedes copiar o descargar el pedido y enviarlo manualmente.'); saveFailedOrder(payload); }
      });
      // focus
      const focusable = modal.querySelector('.om-retry') || modal.querySelector('.om-copy');
      if (focusable) focusable.focus();
      // close on Esc
      const onKey = (ev)=>{ if (ev.key === 'Escape') { modal.remove(); window.removeEventListener('keydown', onKey); } };
      window.addEventListener('keydown', onKey);
    }catch(err){ console.error('showOrderModal', err); showAlert('No se pudo mostrar el modal del pedido — revisa la consola.'); }
  }

  function copyOrderToClipboard(payload){
    try{
      const lines = (payload.items||[]).map(i=>{
        const unitType = normalizeSaleUnit(i?.meta?.unit_type || i?.meta?.sale_unit || i?.meta?.unit);
        const qtyLabel = formatQtyLabel(i?.qty, unitType, i?.meta || {});
        return `${qtyLabel} × ${i.meta?.name || i.id} — $${Number(i.meta?.price||0).toFixed(2)}`;
      });
      const txt = `Pedido:\n${lines.join('\n')}\n\nTotal: $${Number(payload.total||0).toFixed(2)}`;
      navigator.clipboard?.writeText ? navigator.clipboard.writeText(txt) : (function(){ const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); })();
      showToast('Resumen del pedido copiado al portapapeles.');
    }catch(e){ console.error('copyOrder', e); showAlert('No se pudo copiar el pedido automáticamente.'); }
  }

  async function  reAttemptOrder(payload){
    // ensure user info included when reattempting
    const token = getToken();
    try{ console.debug('[reAttemptOrder] token present?', !!token, token ? ('***'+token.slice(-10)) : null); }catch(_){ }
    if (token) {
      try {
        const profileRes = await fetch(`${API_ORIGIN}/auth/me`, { headers: { 'Authorization': `Bearer ${token}` }, mode: 'cors' });
        try{ console.debug('[reAttemptOrder] /auth/me status', profileRes.status); }catch(_){ }
        if (profileRes.ok) {
          const profile = await profileRes.json();
          payload.user_id = payload.user_id || profile.id;
          payload.user_full_name = payload.user_full_name || profile.full_name;
          payload.user_email = payload.user_email || profile.email;
          payload.user_barrio = payload.user_barrio || profile.barrio;
          payload.user_calle = payload.user_calle || profile.calle;
          payload.user_numeracion = payload.user_numeracion || profile.numeracion;
        }
      } catch (e) { console.warn('reAttemptOrder: profile fetch failed', e); }
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
        // provide diagnostic information when a server returns a non-OK response
        try{
          const _body = await res.text();
          console.error('Order POST failed', { url, status: res.status, statusText: res.statusText, body: _body });
        }catch(e){
          console.error('Order POST failed and body could not be read', { url, status: res.status, statusText: res.statusText });
        }
      }catch(err){
        console.error('Order POST network error', url, err);
      }
    }
    return false;
  }

  // Persist failed orders locally so they can be retried across sessions
  function saveFailedOrder(payload){
    try{
      const key = 'catalog:failed_orders_v1';
      // ensure guest contact details are attached when available so the saved payload is complete
      try{
        const g = JSON.parse(localStorage.getItem('catalog:guest_info_v1') || 'null');
        if (g){
          payload.user_full_name = payload.user_full_name || g.name;
          payload.user_email = payload.user_email || g.email;
          payload.user_barrio = payload.user_barrio || g.barrio;
          payload.user_calle = payload.user_calle || g.calle;
          payload.user_numeracion = payload.user_numeracion || g.numero;
        }
      }catch(e){}
      const existing = JSON.parse(localStorage.getItem(key) || '[]');
      existing.push({ payload, ts: Date.now() });
      localStorage.setItem(key, JSON.stringify(existing));
      try{ showToast('Pedido guardado localmente para reintento', 4000); }catch(_){ }
      updateRetryButton();
    }catch(e){ console.warn('saveFailedOrder failed', e); }
  }
  function loadFailedOrders(){ try{ return JSON.parse(localStorage.getItem('catalog:failed_orders_v1') || '[]'); }catch(e){ return []; } }
  function clearFailedOrders(){ try{ localStorage.removeItem('catalog:failed_orders_v1'); updateRetryButton(); }catch(e){} }

  async function retryStoredOrders(){
    try{
      const list = loadFailedOrders();
      if(!list || !list.length){ showToast('No hay pedidos guardados para reintentar'); return; }
      let successCount = 0;
      for(const rec of list.slice()){ // iterate over a copy
        try{
          const ok = await reAttemptOrder(rec.payload);
          if(ok){ successCount++; }
        }catch(e){ console.warn('retryStoredOrders item failed', e); }
      }
      if(successCount > 0){
        // remove only those that were successfully sent: simplest approach — clear all if any succeeded
        clearFailedOrders();
        showToast(`Reintentos completados: ${successCount}`, 4000);
        // give server a moment then refresh to let admin see them
        setTimeout(()=> fetchProducts({ showSkeleton: false }), 800);
      } else {
        showToast('No se pudo enviar ninguno de los pedidos guardados', 4000);
      }
    }catch(e){ console.warn('retryStoredOrders failed', e); showToast('Reintento falló', 3000); }
  }

  // Try to sync locally-stored failed orders directly to the server backup endpoint.
  // This is best-effort and runs automatically on page load so client queues are
  // persisted into the DB as soon as connectivity exists, protecting them across
  // backend deploys.
  async function syncFailedOrdersToServer(){
    try{
      const list = loadFailedOrders();
      if(!list || !list.length) return;
      // Extract payloads and POST as array to /backup-orders (server will persist each)
      const payloads = list.map(r => r.payload);
      try{
        const resp = await fetch((typeof API_ORIGIN === 'string' && API_ORIGIN) ? (API_ORIGIN + '/backup-orders') : '/backup-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloads), mode: 'cors' });
        if(resp.ok){
          // remove local cache on success
          clearFailedOrders();
          showToast('Pedidos guardados en el servidor', 3000);
          setTimeout(()=> fetchProducts({ showSkeleton: false }), 800);
        } else {
          console.warn('syncFailedOrdersToServer: server rejected backup', resp.status);
        }
      }catch(e){ console.warn('syncFailedOrdersToServer network error', e); }
    }catch(e){ console.warn('syncFailedOrdersToServer failed', e); }
  }

  // Ensure we attempt an automatic sync when the page becomes active
  document.addEventListener('DOMContentLoaded', ()=>{ try{ syncFailedOrdersToServer(); }catch(e){} });

  // floating retry button
  function ensureRetryButton(){
    if(document.getElementById('__retry_failed_btn')) return;
    const btn = document.createElement('button'); btn.id='__retry_failed_btn'; btn.className='btn'; btn.style.position='fixed'; btn.style.right='12px'; btn.style.bottom='72px'; btn.style.zIndex='4000'; btn.style.padding='10px 12px'; btn.style.borderRadius='10px'; btn.style.boxShadow='0 8px 24px rgba(2,6,23,0.08)'; btn.style.background='linear-gradient(90deg,var(--accent),var(--accent-2))'; btn.style.color='#fff'; btn.textContent='Reintentar pedidos'; btn.title='Reintentar pedidos guardados localmente'; btn.onclick = ()=>{ retryStoredOrders(); };
    document.addEventListener('DOMContentLoaded', ()=>{ document.body.appendChild(btn); updateRetryButton(); });
  }
  function updateRetryButton(){
    const btn = document.getElementById('__retry_failed_btn');
    if(!btn) return;
    const list = loadFailedOrders();
    const c = (list && list.length) ? list.length : 0;
    btn.style.display = c ? 'block' : 'none';
    btn.textContent = c ? `Reintentar pedidos (${c})` : 'Reintentar pedidos';
  }
  ensureRetryButton();

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
  if (modeEl) modeEl.textContent = mode;
  if (!enabled) {
    if (countdownEl) countdownEl.textContent = '—';
    return;
  }
  countdown = AUTO_REFRESH_SECONDS;
  if (countdownEl) countdownEl.textContent = String(countdown);
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
    if (countdownEl) countdownEl.textContent = String(countdown);
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

// UI bindings for auto-refresh control — resilient when the visible toggle is removed
(function bindAutoControls(){
  const toggle = document.getElementById('autoRefreshToggle');
  const modeEl = document.getElementById('autoMode');
  const statusEl = document.getElementById('autoStatus');
  // read stored values
  const storedEnabled = localStorage.getItem('catalog:auto:enabled');
  const storedMode = localStorage.getItem('catalog:auto:mode') || 'soft';

  // ensure UI reflects mode
  if (modeEl) modeEl.textContent = storedMode;

  // If the toggle UI was removed, keep auto-refresh running by default
  if (!toggle) {
    const enabled = (storedEnabled === null) ? true : (storedEnabled === 'true');
    if (statusEl) {
      statusEl.classList.remove('on','off');
      statusEl.classList.add(enabled ? 'on' : 'off');
      statusEl.innerHTML = `<span class="dot"></span> ${enabled ? 'Activado' : 'Desactivado'}`;
    }
    if (enabled) startAutoRefresh();
    // allow double-click on the mode label to toggle between 'soft' and 'full' modes
    if (modeEl && modeEl.parentElement) {
      modeEl.parentElement.addEventListener('dblclick', (ev) => {
        const next = (localStorage.getItem('catalog:auto:mode') || 'soft') === 'soft' ? 'full' : 'soft';
        localStorage.setItem('catalog:auto:mode', next);
        modeEl.textContent = next;
        if (localStorage.getItem('catalog:auto:enabled') !== 'false') startAutoRefresh();
      });
    }
    return;
  }

  // Legacy path: toggle exists — keep original behavior but defensive
  try{
    const enabled = (storedEnabled === null) ? true : (storedEnabled === 'true');
    toggle.checked = enabled;
    if (modeEl) modeEl.textContent = storedMode;
    if (statusEl) {
      const on = toggle.checked;
      statusEl.classList.remove('on','off');
      statusEl.classList.add(on ? 'on' : 'off');
      statusEl.innerHTML = `<span class="dot"></span> ${on ? 'Activado' : 'Desactivado'}`;
    }
    toggle.addEventListener('change', (e) => {
      const on = e.target.checked;
      localStorage.setItem('catalog:auto:enabled', String(on));
      if (on) startAutoRefresh(); else stopAutoRefresh();
      if (statusEl) { statusEl.classList.remove('on','off'); statusEl.classList.add(on ? 'on' : 'off'); statusEl.innerHTML = `<span class="dot"></span> ${on ? 'Activado' : 'Desactivado'}`; }
    });
    if (modeEl && modeEl.parentElement) {
      modeEl.parentElement.addEventListener('dblclick', (ev) => {
        const next = (localStorage.getItem('catalog:auto:mode') || 'soft') === 'soft' ? 'full' : 'soft';
        localStorage.setItem('catalog:auto:mode', next);
        modeEl.textContent = next;
        if (toggle.checked) startAutoRefresh();
      });
    }
  }catch(e){ console.warn('[catalogo] bindAutoControls failed', e); }
})();

// --- Backend connectivity check ---
async function checkBackendConnectivity(){
  const probeUrls = [
    `${API_ORIGIN}/api/uploads`,
    `${API_ORIGIN}/api/promos`,
    `${API_ORIGIN}/api/consumos`,
  ];
  let ok = false;
  for(const u of probeUrls){
    try{
      const controller = new AbortController();
      const id = setTimeout(()=>controller.abort(), 3000);
      const res = await fetch(u, { method: 'GET', mode: 'cors', signal: controller.signal });
      clearTimeout(id);
      if (res && res.ok){ ok = true; break; }
    }catch(e){}
  }
  if (!ok){
    console.warn('[catalogo] backend appears unreachable at', API_ORIGIN);
    // show a non-intrusive banner so the user knows filters/promotions may not load
    try{
      if (!document.getElementById('__backend_status')){
        const b = document.createElement('div'); b.id='__backend_status'; b.style.position='fixed'; b.style.top='72px'; b.style.left='50%'; b.style.transform='translateX(-50%)'; b.style.zIndex='3500'; b.style.background='linear-gradient(90deg,#fff7ed,#fff)'; b.style.border='1px solid rgba(242,107,56,0.12)'; b.style.padding='8px 12px'; b.style.borderRadius='8px'; b.style.boxShadow='0 10px 30px rgba(2,6,23,0.06)'; b.textContent='Advertencia: no se pudo conectar al backend — algunas funciones (filtros, promos) pueden no funcionar.'; document.body.appendChild(b);
      }
    }catch(e){/* ignore DOM errors */}
  } else {
    console.debug('[catalogo] backend connectivity OK:', API_ORIGIN);
    const el = document.getElementById('__backend_status'); if (el) el.remove();
  }
  return ok;
}

// run a connectivity check after init
document.addEventListener('DOMContentLoaded', ()=>{ try{ setTimeout(()=> checkBackendConnectivity(), 800); }catch(e){} });

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

// Quick server-side token validator for debugging
async function debugWhoami(){
  try{
    const token = getToken();
    if(!token) return { ok: false, error: 'no_local_token' };
    const res = await fetch(API_ORIGIN + '/debug/whoami', { headers: { 'Authorization': `Bearer ${token}` }, mode: 'cors' });
    const js = await res.json().catch(()=>null);
    return js || { ok: false, error: 'no_response' };
  }catch(e){ console.warn('debugWhoami failed', e); return { ok: false, error: String(e) }; }
}

// optional helper button shown only during debugging (not intrusive)
try{
  if (location && location.hostname && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')){
    const dbg = document.createElement('button'); dbg.style.position = 'fixed'; dbg.style.right = '12px'; dbg.style.bottom = '12px'; dbg.style.zIndex = 9999; dbg.textContent = 'Verificar token'; dbg.className = 'btn btn-outline'; dbg.onclick = async ()=>{ const r = await debugWhoami(); showJsonModal(r, 'Verificar token'); };
    document.addEventListener('DOMContentLoaded', ()=>{ document.body.appendChild(dbg); });
  }
}catch(e){}


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

// Modal / dialog helpers (reusable) — enhanced styles and variants
function showDialog({title, message = '', html = '', buttons = [{ label: 'OK', value: true, primary: true }], dismissible = true, type = ''} = {}){
  return new Promise((resolve) => {
    try{
      if (!document.getElementById('__global_dialog_styles')){
        const s = document.createElement('style'); s.id = '__global_dialog_styles'; s.textContent = `
.__dialog_overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,0.36);backdrop-filter:blur(3px);z-index:3200;opacity:0;pointer-events:none;transition:opacity .18s ease}
.__dialog_overlay.open{opacity:1;pointer-events:auto}
.__dialog{width:520px;max-width:calc(100% - 36px);background:linear-gradient(180deg, rgba(255,255,255,0.98), var(--surface));border-radius:14px;padding:16px;box-shadow:0 18px 48px rgba(2,6,23,0.16);color:var(--deep);border:1px solid rgba(10,34,64,0.06);transform:translateY(-6px);transition:transform 200ms ease, opacity 180ms ease}
.__dialog.open{transform:none}
.__dialog .dialog-header{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.__dialog .dialog-header .dialog-icon{width:44px;height:44px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:18px}
.__dialog h3{margin:0;font-size:18px}
.__dialog .dialog-body{max-height:60vh;overflow:auto;color:var(--muted);line-height:1.45}
.__dialog .dialog-body p{margin:0}
.__dialog .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.__dialog .actions .btn{min-width:92px;padding:9px 14px;border-radius:10px}
.__dialog .btn.btn-primary{background:linear-gradient(90deg,var(--accent),var(--accent-2));color:#fff;border:0}
.__dialog .btn.btn-ghost{background:transparent;border:1px solid rgba(0,0,0,0.06);color:var(--deep)}
.__dialog--success .dialog-icon{background:linear-gradient(90deg,#dff7ec,#bff0d9); color:#0a6d3a}
.__dialog--warning .dialog-icon{background:linear-gradient(90deg,#fff5e6,#ffebcc); color:#b86a00}
.__dialog--danger .dialog-icon{background:linear-gradient(90deg,#ffecec,#ffd6d6); color:#9b1e1e}
.__dialog--info .dialog-icon{background:linear-gradient(90deg,#eaf6ff,#dbefff);color:#05507a}
.__dialog input[type="text"], .__dialog input[type="email"]{width:100%;padding:10px;border-radius:8px;border:1px solid #e6e9ef}
@media(max-width:640px){ .__dialog{width:calc(100% - 32px)} }
`;
        document.head.appendChild(s);
      }

      // small map for emoji icons — keeps things fast and dependency-free
      const iconMap = { info: 'ℹ️', success: '✔️', warning: '⚠️', danger: '✖️' };
      const iconHtml = type ? ('<span class="dialog-icon">' + (iconMap[type] || '') + '</span>') : '';

      const overlay = document.createElement('div'); overlay.className = '__dialog_overlay'; overlay.id = '__dialog_overlay';
      const headerHtml = title ? ('<div class="dialog-header">' + iconHtml + '<h3>' + escapeHtml(title) + '</h3></div>') : '';
      const bodyHtml = html ? String(html) : ('<p>' + escapeHtml(message) + '</p>');
      overlay.innerHTML = `<div class="__dialog ${ type ? ('__dialog--' + type) : '' }" role="dialog" aria-modal="true" aria-label="${escapeHtml(title||'Dialog')}">` + headerHtml + `
        <div class="dialog-body">` + bodyHtml + `</div>
        <div class="actions"></div>
      </div>`;

      document.body.appendChild(overlay);
      const dialog = overlay.querySelector('.__dialog');
      const actions = overlay.querySelector('.actions');
      buttons.forEach(btn => {
        const b = document.createElement('button'); b.className = btn.primary ? 'btn btn-primary' : 'btn btn-ghost'; b.textContent = btn.label; b.addEventListener('click', () => { cleanup(); resolve(btn.value); });
        actions.appendChild(b);
      });

      function cleanup(){ try{ overlay.remove(); window.removeEventListener('keydown', onKey); }catch(_){ } }
      if (dismissible) overlay.addEventListener('click', (ev)=>{ if (!ev.target.closest('.__dialog')){ cleanup(); resolve(false); } });
      const onKey = (ev)=>{ if (ev.key === 'Escape'){ cleanup(); resolve(false); } };
      window.addEventListener('keydown', onKey);
      requestAnimationFrame(()=> overlay.classList.add('open'));
      // animate dialog in
      requestAnimationFrame(()=> dialog.classList.add('open'));
      const focusable = actions.querySelector('button'); if (focusable) focusable.focus();
    }catch(e){ console.error('showDialog failed', e); resolve(false); }
  });
}

function showAlert(message, type = 'info'){ return showDialog({ message, type, buttons: [{ label: 'OK', value: true, primary: true }] }); }
function showConfirm(message, type = 'warning'){ return showDialog({ message, type, buttons: [{ label: 'Cancelar', value: false }, { label: 'Aceptar', value: true, primary: true }] }); }
function showJsonModal(obj, title = 'Detalle'){
  const html = `<pre style="white-space:pre-wrap;max-height:48vh;overflow:auto">${escapeHtml(JSON.stringify(obj, null, 2))}</pre>`;
  return showDialog({ title, html, buttons: [{ label: 'Cerrar', value: true, primary: true }], type: 'info' });
}
function showGuestModal(){
  return new Promise((resolve)=>{
    try{
      // build a nicer guest contact modal (styled) and read inputs before removing
      const overlay = document.createElement('div'); overlay.className='__dialog_overlay'; overlay.style.zIndex = 3300;
      overlay.innerHTML = `
        <div class="__dialog __dialog--info" role="dialog" aria-modal="true" aria-label="Datos de contacto (invitado)">
          <div class="dialog-header"><span class="dialog-icon">ℹ️</span><h3>Datos de contacto (invitado)</h3></div>
          <div class="dialog-body">
            <div style="display:flex;flex-direction:column;gap:10px">
              <input id="__gname" type="text" placeholder="Nombre (opcional)" />
              <input id="__gemail" type="email" placeholder="Email (opcional)" />
              <input id="__gbarrio" type="text" placeholder="Barrio (opcional)" />
              <input id="__gcalle" type="text" placeholder="Calle (opcional)" />
              <input id="__gnumero" type="text" placeholder="Numeración (opcional)" />
            </div>
          </div>
          <div class="actions">
            <button class="btn btn-ghost" data-action="cancel">Cancelar</button>
            <button class="btn btn-primary" data-action="save">Guardar</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      // Prefill inputs from last guest info if available so data survives refresh/rerender
      try{
        const last = JSON.parse(localStorage.getItem('catalog:guest_info_v1') || 'null');
        if (last){
          setTimeout(()=>{
            try{
              if (last.name) document.getElementById('__gname').value = last.name;
              if (last.email) document.getElementById('__gemail').value = last.email;
              if (last.barrio) document.getElementById('__gbarrio').value = last.barrio;
              if (last.calle) document.getElementById('__gcalle').value = last.calle;
              if (last.numero) document.getElementById('__gnumero').value = last.numero;
            }catch(_){ }
          }, 50);
        }
      }catch(e){}

      const cancelBtn = overlay.querySelector('[data-action="cancel"]');
      const saveBtn = overlay.querySelector('[data-action="save"]');
      const cleanup = ()=>{ try{ overlay.remove(); window.removeEventListener('keydown', onKey); }catch(_){ } };
      cancelBtn.addEventListener('click', ()=>{ cleanup(); resolve(null); });
      saveBtn.addEventListener('click', ()=>{
        const o = {
          name: (document.getElementById('__gname')?.value || '').trim(),
          email: (document.getElementById('__gemail')?.value || '').trim(),
          barrio: (document.getElementById('__gbarrio')?.value || '').trim(),
          calle: (document.getElementById('__gcalle')?.value || '').trim(),
          numero: (document.getElementById('__gnumero')?.value || '').trim()
        };
        // persist guest info for future attempts / across reloads
        try{ localStorage.setItem('catalog:guest_info_v1', JSON.stringify(o)); }catch(e){}
        cleanup(); resolve(o);
      });
      const onKey = (ev)=>{ if (ev.key === 'Escape') { cleanup(); resolve(null); } };
      window.addEventListener('keydown', onKey);
      // focus first input
      setTimeout(()=>{ try{ document.getElementById('__gname')?.focus(); }catch(_){ } }, 50);
    }catch(e){ console.error('showGuestModal failed', e); resolve(null); }
  });
}

// Helper: fetch with AbortController-based timeout (used for auth requests)
async function fetchWithTimeout(resource, options = {}, timeout = 10000){
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  options.signal = controller.signal;
  try{
    return await fetch(resource, options);
  }finally{
    clearTimeout(id);
  }
}

function updateAuthUI(){ const btn = document.getElementById('authButton'); const token = getToken(); if (!btn) return; if (token){ const payload = parseJwt(token) || {}; const email = payload.sub || payload.email || 'Cuenta'; btn.textContent = `Hola ${email}`; btn.classList.add('logged'); } else { btn.textContent = 'Login'; btn.classList.remove('logged'); } }
async function doRegister(){ const name=document.getElementById('regName').value.trim(); const email=document.getElementById('regEmail').value.trim(); const barrio=document.getElementById('regBarrio').value.trim(); const calle=document.getElementById('regCalle').value.trim(); const numero=document.getElementById('regNumero').value.trim(); const password=document.getElementById('regPassword').value; const err=document.getElementById('regError'); err.textContent=''; if(!name||!email||!password){ err.textContent='Nombre, email y contraseña son obligatorios'; return; } try{ const res=await fetchWithTimeout(AUTH_REGISTER,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name:name,email,barrio,calle,numeracion:numero,password})},10000); if(res.status===400){ const js=await res.json().catch(()=>({})); err.textContent=js.detail||'Error'; return; } if(!res.ok){ err.textContent='Registro falló'; return; } await doLogin(email,password); closeAuthModal(); }catch(e){ if (e && e.name === 'AbortError') err.textContent = 'Tiempo de espera agotado'; else err.textContent='No se pudo conectar con el servidor'; } }
async function doLogin(emailArg,passwordArg){
  const email = emailArg || document.getElementById('loginEmail').value.trim();
  const password = passwordArg || document.getElementById('loginPassword').value;
  const err = document.getElementById('loginError'); err.textContent = '';
  if (!email || !password) { err.textContent = 'Email y contraseña son obligatorios'; return; }
  try {
    const form = new URLSearchParams(); form.append('username', email); form.append('password', password);
    const res = await fetchWithTimeout(AUTH_TOKEN, { method: 'POST', body: form }, 10000);
    if (!res.ok) { const j = await res.json().catch(() => ({})); err.textContent = j.detail || 'Credenciales incorrectas'; return; }
    const data = await res.json();
    if (data && data.access_token) {
      saveToken(data.access_token);
      updateAuthUI();
      // perform quick token check against the server so we can surface any mismatch early
      try{ debugWhoami().then(d => { try{ console.debug('[debugWhoami] result', d); if (d && d.ok && d.payload) { showToast(`Bienvenido, ${d.payload.full_name || d.payload.sub || email}`); } else { showToast('Bienvenido — pero el token no fue validado en el servidor', 'warning'); } }catch(_){}}).catch(e=>{ console.warn('debugWhoami failed', e); }); }catch(_){ }
      // derive display name from token if available
      let name = email;
      try { const p = parseJwt(data.access_token); if (p) name = p.full_name || p.name || p.sub || p.email || email; } catch (e) {}
      closeAuthModal();
      // mark that auth modal was shown this session (ensure consistent behavior)
      try { sessionStorage.setItem('catalog:auth_shown', '1'); } catch(e) {}
    }
  } catch (e) { if (e && e.name === 'AbortError') err.textContent = 'Tiempo de espera agotado'; else err.textContent = 'No se pudo conectar con el servidor'; }
}
function logout(){
  // remove token and update UI
  clearToken();
  try{ sessionStorage.removeItem('catalog:auth_shown'); }catch(e){}
  // reset login/register form fields so user can re-login immediately
  try{ const le=document.getElementById('loginEmail'); const lp=document.getElementById('loginPassword'); if(le) le.value=''; if(lp) lp.value=''; }catch(e){}
  try{ const re=document.getElementById('regEmail'); const rn=document.getElementById('regName'); const rb=document.getElementById('regBarrio'); const rc=document.getElementById('regCalle'); const rnum=document.getElementById('regNumero'); const rp=document.getElementById('regPassword'); if(re) re.value=''; if(rn) rn.value=''; if(rb) rb.value=''; if(rc) rc.value=''; if(rnum) rnum.value=''; if(rp) rp.value=''; }catch(e){}
  // ensure modal closed and UI refreshed
  try{ if(typeof closeAuthModal==='function') closeAuthModal(); }catch(e){}
  updateAuthUI();
  try{ showToast('Sesión cerrada'); }catch(e){}
}
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
  if (authBtn) authBtn.addEventListener('click', async ()=>{
    const token = getToken();
    if (token){ if (await showConfirm('Cerrar sesión?')) { logout(); } return; }
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

  // Check backend health on load and notify user if unreachable
  (async ()=>{
    try{
      const h = await fetchWithTimeout(API_ORIGIN + '/health', {}, 5000);
      if (!h || !h.ok) throw new Error('unhealthy');
    }catch(err){
      console.warn('backend health check failed', err);
      try{ showToast('No se puede conectar con el servidor. Algunas funciones pueden no funcionar.', 6000); }catch(e){}
    }
  })();
});

// Ensure fetchProducts includes Authorization header when token present
const _origFetchProducts = typeof fetchProducts === 'function' ? fetchProducts : null;

// Initialize UI after DOM is ready. Defensive: ensures elements exist so mobile
// browsers that load scripts early don't cause a hard error that stops rendering.
function init(){
  try{
    grid = document.getElementById("catalogGrid") || (function(){ const s = document.createElement('section'); s.id='catalogGrid'; document.body.appendChild(s); return s;} )();
    // ensure there is a visible catalog title for clarity
    if (!document.getElementById('catalogTitle')){
      try{
        const title = document.createElement('div');
        title.id = 'catalogTitle';
        title.className = 'catalog-title';
        const controlsEl = document.querySelector('.controls');
        if (controlsEl && controlsEl.parentNode) {
          // place title near the search/filters area for clearer layout
          controlsEl.parentNode.insertBefore(title, controlsEl);
        } else {
          grid.parentNode && grid.parentNode.insertBefore(title, grid);
        }
      }catch(_){ }
    }
    searchInput = document.getElementById("searchInput") || (function(){ const i = document.createElement('input'); i.id='searchInput'; i.type='search'; document.body.insertBefore(i, grid); return i;} )();
    // Render dynamic filter buttons (admin-managed) or fallback to default inline ones
    try{ renderFilterButtons(); }catch(e){ console.warn('initial renderFilterButtons failed', e); }

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
// WebSocket client: subscribe to product/consumos updates and refresh catalog in near-realtime
function connectProductWS(){
  if (typeof WebSocket === 'undefined') return;
  let socket = null;
  let retries = 0;
  // prefer same-origin host first, then consider API_ORIGIN as fallback
  const hosts = [window.location.host];
  try{ if (typeof API_ORIGIN === 'string' && API_ORIGIN) { const apiHost = (new URL(API_ORIGIN)).host; if (apiHost && apiHost !== window.location.host) hosts.push(apiHost); } }catch(e){}
  let hostIdx = 0;
  let consecutiveFails = 0;
  function _connect(){
    try{
      const wsProtocol = (window.location.protocol === 'https:') ? 'wss' : 'ws';
      const host = hosts[hostIdx % hosts.length];
      const url = wsProtocol + '://' + host + '/ws/products';
      socket = new WebSocket(url);
      socket.onopen = () => { retries = 0; consecutiveFails = 0; console.debug('[catalogo] WS connected to', url); };
      socket.onmessage = (ev) => {
        try{
          const d = JSON.parse(ev.data);
          if (!d || !d.action) return;
          // product updated: refresh products snapshot
          if (d.action === 'updated' && d.product && d.product.id){
            fetchProducts({ showSkeleton: false }).catch(()=>{});
          }
          // consumos updated: refresh consumos
          else if (d.action === 'consumos-updated'){
            fetchConsumos().then(()=>{ try{ render({ animate: true }); }catch(_){} }).catch(()=>{});
          }
          // order created: may affect both stock and consumos
          else if (d.action === 'order_created'){
            try{ fetchProducts({ showSkeleton: false }).catch(()=>{}); fetchConsumos().then(()=>{ try{ render({ animate: true }); }catch(_){} }).catch(()=>{}); }catch(_){ }
          }
        }catch(e){ console.warn('[catalogo] ws message parse failed', e); }
      };
      socket.onclose = (ev) => {
        console.warn('[catalogo] WS closed for host', host, 'retrying...');
        consecutiveFails += 1;
        if (consecutiveFails >= 3 && hosts.length > 1) { hostIdx += 1; consecutiveFails = 0; console.warn('[catalogo] switching to next WS host'); }
        retries += 1;
        const delay = Math.min(60000, Math.max(1000, Math.round(1000 * Math.pow(1.5, retries))));
        setTimeout(_connect, delay);
      };
      socket.onerror = (e) => { console.warn('[catalogo] WS error for host', hosts[hostIdx % hosts.length], e); try{ socket.close(); }catch(_){ } };
    }catch(e){ console.warn('[catalogo] ws connect failed', e); setTimeout(_connect, 3000); }
  }
  // Skip inline fallback block; use host-rotation _connect() only
  _connect();
  return;
    try{
      const wsProtocol = (window.location.protocol === 'https:') ? 'wss' : 'ws';
      let host = null;
      try{ host = (new URL(API_ORIGIN)).host; }catch(e){ host = window.location.host; }
      const url = wsProtocol + '://' + host + '/ws/products';
      /* fallback WebSocket disabled - host-rotation _connect() used */
      socket.onmessage = (ev) => {
        try{
          const d = JSON.parse(ev.data);
          if (!d || !d.action) return;
          // product updated: refresh products snapshot
          if (d.action === 'updated' && d.product && d.product.id){
            fetchProducts({ showSkeleton: false }).catch(()=>{});
          }
          // consumos updated: refresh consumos
          else if (d.action === 'consumos-updated'){
            fetchConsumos().then(()=>{ try{ render({ animate: true }); }catch(_){} }).catch(()=>{});
          }
          // order created: may affect both stock and consumos
          else if (d.action === 'order_created'){
            try{ fetchProducts({ showSkeleton: false }).catch(()=>{}); fetchConsumos().then(()=>{ try{ render({ animate: true }); }catch(_){} }).catch(()=>{}); }catch(_){}
          }
        }catch(e){ console.warn('[catalogo] ws message parse failed', e); }
      };
      socket.onclose = (ev) => { console.warn('[catalogo] WS closed, reconnecting...'); retries += 1; const delay = Math.min(60000, Math.max(1000, Math.round(1000 * Math.pow(1.5, retries)))); setTimeout(_connect, delay); };
      socket.onerror = (e) => { console.warn('[catalogo] WS error', e); try{ socket.close(); }catch(_){ } };
    }catch(e){ console.warn('[catalogo] ws connect failed', e); setTimeout(_connect, 3000); }
  _connect();
}

// Start WS after init so API_ORIGIN is available and DOM is ready
try{ if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ()=>{ setTimeout(()=>{ try{ connectProductWS(); }catch(_){} }, 900); }); else setTimeout(()=>{ try{ connectProductWS(); }catch(_){} }, 900); }catch(e){}

function parsePriceValue(v){
  if (v == null) return null;
  if (typeof v === 'number') return v;
  try{
    const s = String(v).trim();
    if (!s) return null;
    // strip non-numeric chars except . and -
    const cleaned = s.replace(/[^0-9.\-]+/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }catch(_){ return null; }
}
function getProductBasePrice(prod){
  if (!prod) return 0;
  const candidates = [prod.precio, prod.price, prod.unit_price, prod.precio_unit, prod.price_display, prod.price_string, prod.pvp, prod.precio_unitario];
  for (const c of candidates){
    const n = parsePriceValue(c);
    if (n != null) return n;
  }
  // last resort: try scanning object for numeric-looking keys
  try{
    for (const k of Object.keys(prod)){
      const v = prod[k];
      const n = parsePriceValue(v);
      if (n != null && n > 0) return n;
    }
  }catch(_){ }
  return 0;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
