// API: prefer the real endpoint but tolerate variations (English/Spanish)
const API_URL = "https://backend-0lcs.onrender.com";
const API_ORIGIN = new URL(API_URL).origin;
// Auth endpoints
const AUTH_REGISTER = `${API_ORIGIN}/auth/register`;
const AUTH_TOKEN = `${API_ORIGIN}/auth/token`;
const CUSTOMER_TYPE_STORAGE_KEY = 'catalog:customer_type_v1';
const CUSTOMER_TYPE_DEFAULT = 'mayorista';

// DOM references will be initialized in `init()` to avoid race conditions
let grid = null;
let searchInput = null;
let filterButtons = null;

// auto-refresh configuration (seconds)
const AUTO_REFRESH_SECONDS = 30;
let products = [];
let productsRaw = [];
// indica si los productos fueron cargados desde el API remoto o desde el archivo local
let productsSource = 'api';
let currentFilter = "all";
let currentCustomerType = CUSTOMER_TYPE_DEFAULT;
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

function getProductCodeFromObj(obj){
  try{
    const candidates = [obj?.code, obj?.codigo, obj?.cod, obj?.sku];
    for (const candidate of candidates){
      const code = String(candidate || '').trim();
      if (code) return code;
    }
    return '';
  }catch(_){ return ''; }
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

function normalizeCustomerType(value){
  const v = String(value || '').trim().toLowerCase();
  return v === 'minorista' ? 'minorista' : 'mayorista';
}

function getStoredCustomerType(){
  try{
    const stored = localStorage.getItem(CUSTOMER_TYPE_STORAGE_KEY);
    if (!stored) return null;
    return normalizeCustomerType(stored);
  }catch(_){ return null; }
}

function setStoredCustomerType(value){
  try{ localStorage.setItem(CUSTOMER_TYPE_STORAGE_KEY, normalizeCustomerType(value)); }catch(_){ }
}

function getWholesalePriceFromProduct(prod){
  if (!prod) return 0;
  const candidates = [prod.price, prod.precio, prod.unit_price, prod.precio_unit, prod.price_display, prod.price_string, prod.pvp, prod.precio_unitario];
  for (const candidate of candidates){
    const parsed = parsePriceValue(candidate);
    if (parsed != null) return parsed;
  }
  return 0;
}

function getRetailPriceFromProduct(prod, wholesalePrice){
  if (!prod) return wholesalePrice;
  const candidates = [
    prod.price_retail,
    prod.precio_minorista,
    prod.retail_price,
    prod.precioRetail,
    prod.priceMinorista,
    prod.minorista_price,
  ];
  for (const candidate of candidates){
    const parsed = parsePriceValue(candidate);
    if (parsed != null) return parsed;
  }
  return wholesalePrice;
}

function getDisplayPriceForCustomer(prod){
  const wholesale = getWholesalePriceFromProduct(prod);
  const retail = getRetailPriceFromProduct(prod, wholesale);
  const selected = currentCustomerType === 'minorista' ? retail : wholesale;
  return {
    wholesale,
    retail,
    selected
  };
}

// promotions support
let promotions = [];
// consumos (admin-managed immediate-consumption discounts)
let consumos = [];
const DEFAULT_FALLBACK_IMAGE = 'images/icon.png';
const PROMOTIONS_CACHE_KEY = 'catalog:promotions_cache_v2';
const DELIVERY_ADDRESS_CACHE_KEY = 'catalog:delivery_address_v1';
const LOCATION_PREFILL_CACHE_KEY = 'catalog:location_prefill_v1';
const LOCATION_PROMPT_SESSION_KEY = 'catalog:location_prompt_attempted_v1';
const ADDRESS_BOOK_STORAGE_PREFIX = 'catalog:address_book_v1:';
const LAST_USED_ADDRESS_STORAGE_PREFIX = 'catalog:last_used_address_v1:';
const ALLOWED_ADDRESS_REGION = 'mendoza';
const MENDOZA_BOUNDS = Object.freeze({
  minLat: -37.7,
  maxLat: -31.0,
  minLon: -70.7,
  maxLon: -66.2
});
const MENDOZA_DEFAULT_CENTER = Object.freeze({
  lat: -32.8895,
  lon: -68.8458
});
const MENDOZA_POSTAL_TO_DEPARTMENTS = Object.freeze({
  '5500': ['Capital'],
  '5501': ['Godoy Cruz'],
  '5502': ['Godoy Cruz'],
  '5503': ['Godoy Cruz'],
  '5507': ['Lujan de Cuyo'],
  '5509': ['Lujan de Cuyo'],
  '5511': ['Lujan de Cuyo'],
  '5513': ['Maipu'],
  '5515': ['Maipu'],
  '5517': ['Maipu'],
  '5519': ['Guaymallen'],
  '5521': ['Guaymallen'],
  '5523': ['Guaymallen'],
  '5525': ['Guaymallen'],
  '5533': ['Lavalle'],
  '5535': ['Lavalle'],
  '5539': ['Las Heras'],
  '5540': ['Las Heras'],
  '5541': ['Las Heras'],
  '5549': ['Lujan de Cuyo'],
  '5560': ['Tunuyan'],
  '5561': ['Tupungato'],
  '5569': ['San Carlos'],
  '5570': ['San Martin'],
  '5573': ['San Martin', 'Junin'],
  '5575': ['Junin'],
  '5577': ['Rivadavia'],
  '5590': ['La Paz'],
  '5596': ['Santa Rosa'],
  '5600': ['San Rafael'],
  '5603': ['San Rafael'],
  '5613': ['Malargue'],
  '5620': ['General Alvear']
});
const MENDOZA_DEPARTMENTS = Object.freeze(
  Array.from(
    new Set(
      Object.values(MENDOZA_POSTAL_TO_DEPARTMENTS)
        .flat()
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )
);
const NON_MENDOZA_REGION_TOKENS = Object.freeze([
  'buenos aires',
  'caba',
  'cordoba',
  'salta',
  'san juan',
  'san luis',
  'la rioja',
  'catamarca',
  'tucuman',
  'santa fe',
  'entre rios',
  'misiones',
  'corrientes',
  'chaco',
  'formosa',
  'jujuy',
  'santiago del estero',
  'la pampa',
  'neuquen',
  'rio negro',
  'chubut',
  'santa cruz',
  'tierra del fuego'
]);
const ADDRESS_QUERY_STOPWORDS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los',
  'mendoza', 'argentina', 'provincia', 'departamento', 'distrito',
  'calle', 'av', 'avenida'
]);
const SUPPORT_WHATSAPP_E164 = '5492616838446';
const SUPPORT_WHATSAPP_DISPLAY = '+54 9 2616 83-8446';
const SUPPORT_EMAIL = 'distriarmza@gmail.com';
const ORDER_CUTOFF_HOUR = 18;
let authLocationPrefill = null;
let authLocationRequestInFlight = false;
let authLocationMapInstance = null;
let authLocationMapMarker = null;
let addressPickerMapInstance = null;
let addressPickerMapMarker = null;
let addressSearchTimer = null;
let addressSearchActiveRequestId = 0;
let addressSearchAbortController = null;

function loadPromotionsCache(){
  try{
    const raw = localStorage.getItem(PROMOTIONS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
    return normalizePromotionsList(items);
  }catch(_){ return []; }
}

function savePromotionsCache(items){
  try{
    const normalized = normalizePromotionsList(Array.isArray(items) ? items : []);
    localStorage.setItem(PROMOTIONS_CACHE_KEY, JSON.stringify({ ts: Date.now(), items: normalized }));
  }catch(_){ }
}

function parsePromoDate(value){
  if (!value) return null;
  try{
    const raw = String(value).trim();
    if (!raw) return null;
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
  }catch(_){ return null; }
}

function normalizePromotionItem(item){
  if (!item || typeof item !== 'object') return null;
  const idsRaw = Array.isArray(item.productIds) ? item.productIds : (Array.isArray(item.product_ids) ? item.product_ids : []);
  const productIds = idsRaw
    .map(v => (v === null || v === undefined) ? '' : String(v).trim())
    .filter(Boolean);
  if (!productIds.length) return null;

  const idVal = item.id != null ? item.id : ('promo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const typeVal = String(item.type || 'percent').trim().toLowerCase();
  const valueNum = (item.value !== null && item.value !== undefined && item.value !== '') ? Number(item.value) : null;
  const validUntilRaw = item.valid_until ?? item.validUntil ?? item.expires_at ?? item.ends_at ?? null;
  const validUntilDate = parsePromoDate(validUntilRaw);

  return {
    id: idVal,
    name: String(item.name || 'Promocion').trim(),
    description: String(item.description || '').trim(),
    productIds,
    type: typeVal,
    value: Number.isFinite(valueNum) ? valueNum : null,
    valid_until: validUntilDate ? validUntilDate.toISOString() : null
  };
}

function normalizePromotionsList(items){
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items){
    const normalized = normalizePromotionItem(it);
    if (normalized) out.push(normalized);
  }
  return out;
}

function isPromotionExpired(promo, nowTs = Date.now()){
  const dt = parsePromoDate(promo && promo.valid_until);
  if (!dt) return false;
  return dt.getTime() < nowTs;
}

function isPromotionActive(promo, nowTs = Date.now()){
  return !isPromotionExpired(promo, nowTs);
}

function getPromotionValidityInfo(promo){
  const dt = parsePromoDate(promo && promo.valid_until);
  if (!dt) return { text: '', className: '' };
  const nowTs = Date.now();
  const remainingMs = dt.getTime() - nowTs;
  const dateLabel = dt.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  if (remainingMs <= 0){
    return { text: 'Vencida: ' + dateLabel, className: 'expired' };
  }
  const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));
  if (remainingHours <= 48){
    return { text: 'Valida hasta ' + dateLabel + ' (' + remainingHours + 'h)', className: 'expiring' };
  }
  return { text: 'Valida hasta ' + dateLabel, className: '' };
}

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
  // Only use promotions endpoints (NOT /api/promos, which is promo images).
  // Prefer backend canonical source first.
  const tryUrls = [
    `${API_ORIGIN}/promotions`,
    `${API_ORIGIN}/promociones`,
    '/promotions',
    '/promociones'
  ];
  const seenUrls = new Set();
  for (const url of tryUrls){
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    try {
      const res = await fetch(url, { mode: 'cors', cache: 'no-store' });
      if (!res.ok) continue;
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) continue;
      const data = await res.json();
      // tolerate different payload shapes: array, { promotions: [...] }, { data: [...] }
      let list = null;
      if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.promotions)) list = data.promotions;
      else if (data && Array.isArray(data.data)) list = data.data;
      if (!Array.isArray(list)) continue;

      // Important: if backend intentionally returns [] we keep it as authoritative
      // and do not resurrect stale local promos.
      const normalized = normalizePromotionsList(list);
      promotions = normalized;
      savePromotionsCache(normalized);
      return promotions;
    } catch (err) { /* ignore and try next */ }
  }

  // fallback: use last known-good backend snapshot cache only
  const cached = loadPromotionsCache();
  if (cached.length){
    promotions = cached;
    return promotions;
  }

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
          promotions = normalizePromotionsList(ev.data.promos);
          savePromotionsCache(promotions);
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
    allBtn.addEventListener('click', ()=>{ currentFilter = 'all'; render({ animate: true }); Array.from(container.querySelectorAll('button')).forEach(b=>b.classList.remove('active')); allBtn.classList.add('active'); });
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

    // Show only selected filters (active). Non-selected filters stay hidden until chosen from modal.
    const activeFilters = loadActiveFilters();
    const byValue = new Map();
    for (const f of (allFilters || [])) {
      const value = String(f.value || '').toLowerCase();
      if (!value || byValue.has(value)) continue;
      byValue.set(value, { value, name: String(f.name || f.value || value) });
    }
    const listToShow = [];
    const seenSelected = new Set();
    for (const valRaw of (activeFilters || [])) {
      const val = String(valRaw || '').toLowerCase();
      if (!val || seenSelected.has(val) || !byValue.has(val)) continue;
      seenSelected.add(val);
      listToShow.push(byValue.get(val));
    }

    for(const f of listToShow){
      try{
        const b = document.createElement('button');
        b.dataset.filter = f.value || String(f.name || '').toLowerCase();
        b.textContent = f.name || f.value;
        b.addEventListener('click', ()=>{ currentFilter = b.dataset.filter; render({ animate: true }); Array.from(container.querySelectorAll('button')).forEach(x=>x.classList.remove('active')); b.classList.add('active'); });
        // mark active if currentFilter matches
        const val = (b.dataset.filter || '').toLowerCase();
        if ((currentFilter && currentFilter.toLowerCase() === val)){ b.classList.add('active'); allBtn.classList.remove('active'); }
        container.appendChild(b);
      }catch(e){ console.warn('[catalogo] renderFilterButtons: failed creating button for filter', f, e); }
    }

    // mark 'Todos' active when there is no specific current filter
    if(!currentFilter || currentFilter === 'all'){
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
  const nowTs = Date.now();
  // allow passing either a product object or an id/string
  let candidates = [];
  const prodObj = (typeof product === 'object' && product !== null) ? product : null;
  const prodId = prodObj ? (prodObj.id ?? prodObj._id ?? prodObj._id_str ?? prodObj.sku) : product;
  const prodName = prodObj ? (prodObj.nombre || prodObj.name || '') : '';
  const pidStr = prodId !== undefined && prodId !== null ? String(prodId) : null;

  const matches = promotions.filter(pr => {
    if (!isPromotionActive(pr, nowTs)) return false;
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

function getPromotionProducts(promo){
  try{
    const promoIds = Array.isArray(promo && promo.productIds) ? promo.productIds : [];
    if (!promoIds.length) return [];
    const out = [];
    const seen = new Set();
    for (const rawId of promoIds){
      const idStr = String(rawId == null ? '' : rawId).trim();
      if (!idStr) continue;
      const found = (products || []).find((p) => {
        const pid = String(p.id ?? p._id ?? p.nombre ?? p.name ?? '').trim();
        if (!pid) return false;
        if (pid === idStr) return true;
        if (!Number.isNaN(Number(pid)) && !Number.isNaN(Number(idStr)) && Number(pid) === Number(idStr)) return true;
        const pname = String(p.nombre || p.name || '').trim().toLowerCase();
        return !!pname && pname === idStr.toLowerCase();
      });
      if (!found) continue;
      const productKey = String(found.id ?? found._id ?? found.nombre ?? found.name ?? idStr);
      if (seen.has(productKey)) continue;
      seen.add(productKey);
      const basePrice = Number(found.precio ?? found.price ?? 0) || 0;
      const finalPrice = Number(getDiscountedPrice(basePrice, promo) || basePrice);
      out.push({
        id: productKey,
        name: found.nombre || found.name || idStr,
        description: found.descripcion || found.description || '',
        image: found.imagen || found.image || found.image_url || 'images/placeholder.png',
        basePrice,
        finalPrice
      });
    }
    return out;
  }catch(_){
    return [];
  }
}

async function openPromotionDetail(promoId){
  const promo = (promotions || []).find((p) => String(p.id) === String(promoId) && isPromotionActive(p));
  if (!promo){
    await showAlert('Esta promocion ya no esta vigente', 'warning');
    return;
  }
  const included = getPromotionProducts(promo);
  if (!included.length){
    await showAlert('No encontramos productos disponibles para esta promocion', 'warning');
    return;
  }

  const validityInfo = getPromotionValidityInfo(promo);
  const totalBase = included.reduce((sum, item) => sum + Number(item.basePrice || 0), 0);
  const totalFinal = included.reduce((sum, item) => sum + Number(item.finalPrice || 0), 0);
  const savings = Math.max(0, totalBase - totalFinal);
  const itemsHtml = included.map((item) => {
    const hasDiscount = Number(item.finalPrice) < Number(item.basePrice);
    const priceHtml = hasDiscount
      ? ('<span style="font-weight:900;color:var(--accent)">$' + Number(item.finalPrice).toFixed(2) + '</span> <span style="text-decoration:line-through;color:var(--muted);font-size:12px;margin-left:6px">$' + Number(item.basePrice).toFixed(2) + '</span>')
      : ('<span style="font-weight:900;color:var(--deep)">$' + Number(item.finalPrice).toFixed(2) + '</span>');
    const descText = String(item.description || '').trim();
    const safeDesc = descText ? ('<div style="font-size:12px;color:var(--muted);margin-top:2px">' + escapeHtml(descText) + '</div>') : '';
    return '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(10,34,64,0.06)">' +
      '<img src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.name) + '" style="width:54px;height:54px;border-radius:10px;object-fit:cover;border:1px solid rgba(10,34,64,0.08)">' +
      '<div style="flex:1;min-width:0">' +
      '<div style="font-weight:800;color:var(--deep);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(item.name) + '</div>' +
      safeDesc +
      '</div>' +
      '<div style="text-align:right;white-space:nowrap">' + priceHtml + '</div>' +
      '</div>';
  }).join('');

  const detailHtml =
    '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<div style="font-size:13px;color:var(--muted)">' + escapeHtml(promo.description || '') + '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<span style="background:rgba(10,34,64,0.06);padding:4px 8px;border-radius:999px;font-size:12px;font-weight:700;color:var(--deep)">Incluye ' + String(included.length) + ' producto' + (included.length === 1 ? '' : 's') + '</span>' +
        (validityInfo.text ? ('<span style="background:rgba(10,34,64,0.06);padding:4px 8px;border-radius:999px;font-size:12px;font-weight:700;color:var(--deep)">' + escapeHtml(validityInfo.text) + '</span>') : '') +
      '</div>' +
      '<div style="border:1px solid rgba(10,34,64,0.08);border-radius:12px;padding:10px 12px;max-height:42vh;overflow:auto;background:#fff">' + itemsHtml + '</div>' +
      '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:14px">' +
        '<strong style="color:var(--deep)">Total promo: $' + Number(totalFinal).toFixed(2) + '</strong>' +
        (savings > 0 ? ('<span style="color:var(--accent);font-weight:800">Ahorro: $' + Number(savings).toFixed(2) + '</span>') : '') +
      '</div>' +
    '</div>';

  const accepted = await showDialog({
    title: promo.name || 'Promocion',
    html: detailHtml,
    type: 'info',
    buttons: [
      { label: 'Cerrar', value: false, primary: false },
      { label: 'Agregar promocion', value: true, primary: true }
    ]
  });
  if (!accepted) return;
  const promoCartId = 'promo:' + String(promo.id);
  addToCart(promoCartId, 1, null);
  openCart();
}

function normalize(p) {
  // soporta respuesta en español o inglés y normaliza valores
  const name = (p.nombre || p.name || "").trim();
  const description = (p.descripcion || p.description || "").trim();
  const category = (p.categoria || p.category || "").trim();
  const code = getProductCodeFromObj(p);
  const pricing = getDisplayPriceForCustomer(p);
  const price = pricing.selected;
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
    code,
    codigo: code,
    nombre: name,
    descripcion: description,
    categoria: category,
    price: price,
    precio: price,
    price_wholesale: pricing.wholesale,
    price_retail: pricing.retail,
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

  // Promotion click handlers are wired in render() after cards are created.
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
        productsRaw = Array.isArray(local) ? local : [];
        products = productsRaw.map(normalize);
        await fetchPromotions();
        await fetchConsumos();
        syncCartPricesForCustomerType();
        render({ animate: true });
        showMessage('Mostrando catálogo desde caché local (offline).', 'info');
        return;
      }
    } catch (cacheErr) { console.warn('cache read failed', cacheErr); }

    showMessage('No se pudieron cargar productos desde el backend. Usando catálogo local si está disponible. ⚠️', 'warning');
    try {
      const local = await (await fetch('products.json')).json();
      productsSource = 'local';
      productsRaw = Array.isArray(local) ? local : [];
      products = productsRaw.map(normalize);
      await fetchPromotions();
      await fetchConsumos();
      syncCartPricesForCustomerType();
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
  productsRaw = Array.isArray(data) ? data : [];
  products = productsRaw.map(normalize);
  try { localStorage.setItem('catalog:products_cache_v1', JSON.stringify(data)); localStorage.setItem('catalog:products_cache_ts', String(Date.now())); } catch (e) { /* ignore */ }
  await fetchPromotions();
  await fetchConsumos();
  syncCartPricesForCustomerType();
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
    const productCode = String(p.code || p.codigo || '').toLowerCase();
    const matchesSearch =
      (p.nombre || '').toLowerCase().includes(search) ||
      (p.descripcion || '').toLowerCase().includes(search) ||
      productCode.includes(search);
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
    const focusedFilter = (currentFilter && String(currentFilter).toLowerCase() !== 'all')
      ? String(currentFilter).toLowerCase()
      : '';
    const filtersToMatch = focusedFilter ? [focusedFilter] : activeFilters;
    // If no selected filters, show all. If one chip is focused, filter only by that chip.
    const matchesFilter = (!filtersToMatch || filtersToMatch.length === 0) || filtersToMatch.some(fv => ((assigned && assigned.includes(fv)) || prodCats.includes(fv)));
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
  // ensure promotions section exists (styled like catalog) and contains the promos row
  let promotionsSection = document.getElementById('promotionsSection');
  if (!promotionsSection) {
    promotionsSection = document.createElement('section');
    promotionsSection.id = 'promotionsSection';
    promotionsSection.className = 'promotions-section';
    promotionsSection.innerHTML = '<div class="promotions-header"><h2 class="promotions-title">Promociones <small id="promotionsCount" class="promotions-sub"></small></h2></div><div class="promotions-wrap"><div id="promotionsRow" class="promotions-row"></div></div>';
  }
  if (!promotionsSection.parentNode) {
    try{
      if (grid.parentNode) grid.parentNode.insertBefore(promotionsSection, grid);
      else document.body.insertBefore(promotionsSection, grid);
    }catch(e){ document.body.appendChild(promotionsSection); }
  }
  let promosRow = document.getElementById('promotionsRow');
  if (!promosRow) {
    promosRow = document.createElement('div');
    promosRow.id = 'promotionsRow';
    promosRow.className = 'promotions-row';
    try{
      promotionsSection.appendChild(promosRow);
    }catch(e){ document.body.appendChild(promosRow); }
  }

  if (filtered.length === 0) {
    grid.innerHTML = '<p class="message">No hay resultados</p>';
    promosRow.innerHTML = ''; // clear promos when no results
    if (promotionsSection) promotionsSection.style.display = 'none';
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
      const promosAnchor = document.getElementById('promotionsSection') || promosRow;
      if (promosAnchor && promosAnchor.parentNode) promosAnchor.parentNode.insertBefore(consumosSection, promosAnchor);
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
          const imgSrc = match.imagen || match.image || DEFAULT_FALLBACK_IMAGE;
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
  const activePromotions = Array.isArray(promotions) ? promotions.filter(pr => isPromotionActive(pr)) : [];
  if (activePromotions.length) {
    if (promotionsSection) promotionsSection.style.display = '';
    const promoFrag = document.createDocumentFragment();
    // clear previous promos container
    promosRow.innerHTML = '';
    const seen = new Set();
    activePromotions.forEach(pr => {
      try {
        const prIds = Array.isArray(pr.productIds) ? pr.productIds.map(x => String(x)) : [];
        const sourceProducts = (Array.isArray(products) && products.length) ? products : filtered;
        const match = sourceProducts.find(p => {
          const pid = String(p.id ?? p._id ?? p.nombre ?? p.name ?? '');
          if (prIds.length && prIds.includes(pid)) return true;
          // fallback: try matching by product name
          if (prIds.length && prIds.some(x => x.toLowerCase() === String(p.nombre || p.name || '').toLowerCase())) return true;
          return false;
        });
        if (seen.has(pr.id)) return;
        seen.add(pr.id);
        const card = document.createElement('article');
        card.className = 'promotion-card reveal';
        card.dataset.pid = String(pr.id);
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', 'Ver detalle de la promocion ' + String(pr.name || ''));
        const imgSrc = (match && (match.imagen || match.image)) ? (match.imagen || match.image) : DEFAULT_FALLBACK_IMAGE;
        // compute readable promo label: support percent as fraction (0.12) or as whole number (12)
        let promoLabel = 'Oferta';
        const validityInfo = getPromotionValidityInfo(pr);
        const validityClass = validityInfo.className ? (' promo-validity ' + validityInfo.className) : ' promo-validity';
        const includedCount = Array.isArray(pr.productIds) ? pr.productIds.length : 0;
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
          <div class="product-thumb"><img src="${imgSrc}" alt="${escapeHtml(pr.name || 'Promocion')}"></div>
            <div class="product-info">
            <div class="promo-head">
              <h3 class="product-title">${escapeHtml(pr.name || 'Promoción')}</h3>
              <div class="price-display">${promoLabel}</div>
            </div>
            <div class="product-sub">${escapeHtml(pr.description || (match ? (match.descripcion || '') : ''))}</div>
            <div class="promo-count">Incluye ${includedCount} producto${includedCount === 1 ? '' : 's'}</div>
            ${validityInfo.text ? ('<div class="' + validityClass + '">' + escapeHtml(validityInfo.text) + '</div>') : ''}
            <div class="product-actions"><button class="btn btn-primary promo-view" data-pid="${escapeHtml(String(pr.id))}">Ver promo</button></div>
          </div>`;
        try{
          const promoImg = card.querySelector('img');
          if (promoImg) promoImg.addEventListener('error', () => { promoImg.src = DEFAULT_FALLBACK_IMAGE; });
        }catch(_){ }
        promoFrag.appendChild(card);
      } catch (e) { /* ignore individual promo errors */ }
    });
    // append promos into the promotionsRow (separate from product grid)
    promosRow.appendChild(promoFrag);
    try{
      const promotionsCountEl = document.getElementById('promotionsCount');
      if (promotionsCountEl) promotionsCountEl.textContent = ' ' + String(activePromotions.length) + ' activa' + (activePromotions.length === 1 ? '' : 's');
    }catch(_){ }
  } else {
    promosRow.innerHTML = '';
    if (promotionsSection) promotionsSection.style.display = 'none';
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

    // find per-product discount if present on the product object
    let perProductDiscount = null;
    try{ const d = Number(p.discount ?? p.descuento ?? 0); if(!Number.isNaN(d) && d > 0) perProductDiscount = d; }catch(_){ perProductDiscount = null; }

    // Product cards only honor per-product discounts.
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

    const discounted = discountedConsumo;

    // Sync cart items for this product (non-consumo) so the cart always reflects current pricing rules.
    try{
      const targetPrice = discounted != null ? Number(discounted) : Number(basePrice);
      const cart = readCart();
      let changed = false;
      for (let ci of cart) {
        if (String(ci.id) === String(pid) && !(ci.meta && ci.meta.consumo)) {
          const current = Number(ci.meta && ci.meta.price != null ? ci.meta.price : (ci.meta && ci.meta.price === 0 ? 0 : null));
          if (Number.isFinite(current) ? Number(current) !== Number(targetPrice) : true) {
            if (!ci.meta) ci.meta = {};
            ci.meta.price = Number(targetPrice);
            changed = true;
          }
        }
      }
      if (changed) { try{ writeCart(cart); }catch(_){ } }
    }catch(_){ }

    const isNew = p.created_at ? (Date.now() - new Date(p.created_at).getTime()) < (1000 * 60 * 60 * 24 * 7) : false;

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
    revealed.forEach((el) => {
      el.addEventListener('animationend', () => el.classList.remove('reveal'), { once: true });
      // Fallback: if animations are disabled by browser/extension, ensure cards become visible.
      setTimeout(() => { try{ el.classList.remove('reveal'); }catch(_){ } }, 900);
    });
  }

  // Wire promotion cards/buttons: open promo detail with all included products.
  try {
    const openPromoById = (pid) => {
      if (!pid) return;
      openPromotionDetail(String(pid));
    };
    document.querySelectorAll('.promotion-card .promo-view').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const pid = btn.getAttribute('data-pid');
        openPromoById(pid);
      });
      btn.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          ev.stopPropagation();
          openPromoById(btn.getAttribute('data-pid'));
        }
      });
    });
    document.querySelectorAll('.promotion-card').forEach(card => {
      card.addEventListener('click', (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest('.btn')) return;
        openPromoById(card.getAttribute('data-pid'));
      });
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openPromoById(card.getAttribute('data-pid'));
        }
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

function syncCartPricesForCustomerType(){
  try{
    const cart = readCart();
    if (!Array.isArray(cart) || !cart.length) return;
    let changed = false;
    for (const item of cart){
      if (!item) continue;
      const itemId = String(item.id ?? '');
      if (itemId.startsWith('promo:')) {
        const promoId = String(item.meta?.promo_id || itemId.split(':')[1] || '');
        const promo = promotions.find(p => String(p.id) === promoId);
        if (!promo || !Array.isArray(promo.productIds)) continue;
        const included = promo.productIds.map((pidItem) => {
          const prod = products.find(p => String(p.id ?? p._id) === String(pidItem) || String(p.nombre || p.name || '') === String(pidItem));
          if (!prod) return null;
          const unitBase = Number(prod.precio ?? prod.price ?? 0) || 0;
          const discounted = getDiscountedPrice(unitBase, promo);
          return { id: String(prod.id ?? prod._id ?? pidItem), name: prod.nombre || prod.name || '', price: Number(discounted || unitBase), image: prod.imagen || prod.image || '' };
        }).filter(Boolean);
        if (included.length) {
          const total = included.reduce((sum, x) => sum + Number(x.price || 0), 0);
          if (!item.meta) item.meta = {};
          const nextTotal = Number(total.toFixed(2));
          if (Number(item.meta.price || 0) !== nextTotal) changed = true;
          item.meta.price = nextTotal;
          item.meta.products = included;
        }
        continue;
      }
      if (item.meta && item.meta.consumo) continue;
      const prod = products.find(p => String(p.id ?? p._id) === itemId);
      if (!prod) continue;
      const targetPrice = Number(prod.precio ?? prod.price ?? 0) || 0;
      if (!item.meta) item.meta = {};
      if (Number(item.meta.price || 0) !== targetPrice) {
        item.meta.price = targetPrice;
        changed = true;
      }
    }
    if (changed) writeCart(cart);
  }catch(_){ }
}

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
    const productCode = getProductCodeFromObj(prod);
    if (productCode) {
      mergedMeta.code = productCode;
      mergedMeta.codigo = productCode;
    }
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
    const promo = promotions.find(p => String(p.id) === String(promoId) && isPromotionActive(p));
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
      cart.push({
        id: String(productId),
        qty: Math.min(99, qty),
        meta: {
          name: promo.name || 'Promoción',
          promo_name: promo.name || 'Promoción',
          promo_id: promo.id != null ? String(promo.id) : null,
          is_promo: true,
          price: Number(total.toFixed(2)),
          image: included[0].image || '',
          products: included
        }
      });
      writeCart(cart);
      renderCart();
      // no per-product pulse animation; briefly pulse cart instead
      try{ document.getElementById('cartButton')?.animate?.([{ transform: 'scale(1)' },{ transform: 'scale(1.06)' },{ transform: 'scale(1)' }], { duration: 380 }); }catch(_){ }
      return;
    }
    showAlert('Esta promocion ya no esta vigente', 'warning');
    return;
  }

  // Default single product add
  const p = products.find(x => String(x.id ?? x._id) === String(productId));
  if (!p) return; // avoid adding unknown ids
  const productCode = getProductCodeFromObj(p);
  const meta = {
    name: p?.nombre || p?.name || '',
    price: p?.precio ?? p?.price ?? 0,
    image: p?.imagen || p?.image || p?.image_url || '',
    unit_type: getSaleUnitFromObj(p),
    code: productCode || undefined,
    codigo: productCode || undefined
  };
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
        #cartDrawer .cart-item{
          padding:12px;
          gap:10px;
          display:grid;
          grid-template-columns:84px minmax(0,1fr);
          grid-template-areas:
            "img info"
            "controls controls";
          align-items:start;
        }
        #cartDrawer .cart-item .ci-image{grid-area:img}
        #cartDrawer .cart-item .ci-info{grid-area:info;min-width:0}
        #cartDrawer .cart-item .ci-controls{
          grid-area:controls;
          margin-left:0;
          width:100%;
          justify-content:space-between;
          gap:10px;
        }
        #cartDrawer .cart-item .ci-name{font-size:14px;line-height:1.25}
        #cartDrawer .cart-item .ci-name-text{display:block;white-space:normal;word-break:break-word}
        #cartDrawer .cart-item .ci-sub{font-size:12px;line-height:1.3}
        #cartDrawer .cart-item .qty{flex:1;justify-content:center;min-width:0}
        #cartDrawer .cart-item .btn.remove{white-space:nowrap;padding:8px 10px}
        #cartDrawer .ci-image img{width:84px;height:84px}
      }
      @media(max-width:420px){
        #cartDrawer .cart-item{grid-template-columns:74px minmax(0,1fr)}
        #cartDrawer .ci-image img{width:74px;height:74px}
        #cartDrawer .cart-item .ci-controls{gap:8px}
        #cartDrawer .cart-item .btn.remove{font-size:13px;padding:8px 10px}
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
      // fallback: prefer stored meta.price when present (non-consumo), otherwise product base
      const livePriceBase = (item.meta && item.meta.price != null) ? Number(item.meta.price) : productBase;
      unitPrice = (item.meta && item.meta.consumo && item.meta.price != null) ? Number(item.meta.price) : livePriceBase;
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

function shouldTryPageOriginOrders(pageOrigin){
  try{
    const origin = String(pageOrigin || '').trim();
    if (!origin) return false;
    if (!(typeof API_ORIGIN === 'string' && API_ORIGIN)) return true;
    if (origin === API_ORIGIN) return true;
    const localHosts = new Set(['localhost', '127.0.0.1']);
    const pageHost = new URL(origin).hostname;
    const apiHost = new URL(API_ORIGIN).hostname;
    return localHosts.has(pageHost) && localHosts.has(apiHost);
  }catch(_){ return false; }
}

function buildOrdersRequestUrls(query = ''){
  const suffix = '/orders' + String(query || '');
  const urls = [];
  try{
    const pageOrigin = (location && location.protocol && location.protocol.startsWith('http') && location.origin) ? location.origin : null;
    if (typeof API_ORIGIN === 'string' && API_ORIGIN) urls.push(API_ORIGIN + suffix);
    if (pageOrigin && shouldTryPageOriginOrders(pageOrigin)) {
      urls.push(pageOrigin + suffix);
      urls.push(suffix);
    }
  }catch(_){
    urls.push(suffix);
  }
  const seen = new Set();
  return urls.filter((u) => {
    const url = String(u || '').trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function buildBackupOrdersRequestUrls(){
  const suffix = '/backup-orders';
  const urls = [];
  try{
    const pageOrigin = (location && location.protocol && location.protocol.startsWith('http') && location.origin) ? location.origin : null;
    if (typeof API_ORIGIN === 'string' && API_ORIGIN) urls.push(API_ORIGIN + suffix);
    if (pageOrigin && shouldTryPageOriginOrders(pageOrigin)) {
      urls.push(pageOrigin + suffix);
      urls.push(suffix);
    }
  }catch(_){
    urls.push(suffix);
  }
  const seen = new Set();
  return urls.filter((u) => {
    const url = String(u || '').trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function waitMs(ms){
  const delay = Number(ms || 0);
  return new Promise((resolve) => setTimeout(resolve, delay > 0 ? delay : 0));
}

function extractOrderErrorDetail(rawBody){
  const raw = String(rawBody || '').trim();
  if (!raw) return '';
  try{
    const parsed = JSON.parse(raw);
    const detail = parsed && (parsed.detail || parsed.error || parsed.message);
    if (typeof detail === 'string') return detail.slice(0, 280);
    if (detail && typeof detail === 'object') {
      return JSON.stringify(detail).slice(0, 280);
    }
  }catch(_){ }
  return raw.replace(/\s+/g, ' ').slice(0, 280);
}

function sanitizeOrderItemMetaForRequest(meta){
  const src = (meta && typeof meta === 'object') ? meta : {};
  const out = {};
  const keepStr = ['name', 'code', 'codigo', 'unit_type', 'sale_unit', 'qty_label', 'key', 'price_mode'];
  const keepNum = ['price', 'kg_per_unit', 'ordered_weight_kg', 'promo_id', 'consumo_id'];
  const keepBool = ['consumo', 'force_regular'];

  for (const key of keepStr){
    if (!(key in src)) continue;
    const val = src[key];
    if (val == null) continue;
    const txt = String(val);
    const maxLen = (key === 'name' || key === 'qty_label') ? 140 : 80;
    out[key] = txt.slice(0, maxLen);
  }
  for (const key of keepNum){
    if (!(key in src)) continue;
    const num = Number(src[key]);
    if (Number.isFinite(num)) out[key] = num;
  }
  for (const key of keepBool){
    if (!(key in src)) continue;
    out[key] = !!src[key];
  }
  return out;
}

function buildSanitizedOrderPayload(payload){
  const src = (payload && typeof payload === 'object') ? payload : {};
  const clean = Object.assign({}, src);
  clean.items = (Array.isArray(src.items) ? src.items : []).map((it) => {
    const idRaw = (it && (it.id != null ? it.id : it._id)) || '';
    const id = String(idRaw || '').trim();
    const qtyRaw = Number(it && it.qty != null ? it.qty : 1);
    return {
      id,
      qty: Number.isFinite(qtyRaw) ? qtyRaw : 1,
      meta: sanitizeOrderItemMetaForRequest(it && it.meta ? it.meta : {}),
    };
  });
  return clean;
}

function buildOrderSignature(items){
  try{
    if (!Array.isArray(items)) return '';
    return items
      .map((it) => {
        const id = String((it && (it.id != null ? it.id : it._id)) || '').trim();
        const qty = Number(it && it.qty != null ? it.qty : 0);
        const q = Number.isFinite(qty) ? qty.toFixed(3) : '0.000';
        return id + ':' + q;
      })
      .filter(Boolean)
      .sort()
      .join('|');
  }catch(_){ return ''; }
}

async function findRecentlyCreatedMatchingOrder(payload, baseHeaders){
  const targetEmail = String(payload && payload.user_email ? payload.user_email : '').trim().toLowerCase();
  if (!targetEmail) return null;
  const targetTotal = Number(payload && payload.total != null ? payload.total : 0);
  const targetSignature = buildOrderSignature(payload && payload.items ? payload.items : []);
  const nowMs = Date.now();
  const urls = buildOrdersRequestUrls('?skip=0&limit=40');
  for (const url of urls){
    try{
      const res = await fetch(url, { method: 'GET', headers: baseHeaders, mode: 'cors' });
      if (!res.ok) continue;
      const rows = await res.json().catch(() => null);
      if (!Array.isArray(rows)) continue;
      for (const row of rows){
        const rowEmail = String(row && row.user_email ? row.user_email : '').trim().toLowerCase();
        if (!rowEmail || rowEmail !== targetEmail) continue;
        const rowTotal = Number(row && row.total != null ? row.total : 0);
        if (!Number.isFinite(rowTotal) || Math.abs(rowTotal - targetTotal) > 0.01) continue;
        const rowSignature = buildOrderSignature(row && row.items ? row.items : []);
        if (targetSignature && rowSignature && targetSignature !== rowSignature) continue;
        const createdAtMs = Date.parse(String(row && row.created_at ? row.created_at : ''));
        if (Number.isFinite(createdAtMs) && Math.abs(nowMs - createdAtMs) > (15 * 60 * 1000)) continue;
        return row;
      }
    }catch(_){ }
  }
  return null;
}

async function probeCreatedOrderAfterServerError(payload, baseHeaders){
  const waitPlan = [250, 500, 900];
  for (const ms of waitPlan){
    await waitMs(ms);
    try{
      const existingOrder = await findRecentlyCreatedMatchingOrder(payload, baseHeaders);
      if (existingOrder && existingOrder.id != null) return existingOrder;
    }catch(_){ }
  }
  return null;
}

async function submitOrderPayload(payload, baseHeaders){
  const requestPayload = buildSanitizedOrderPayload(payload);
  const tryUrls = buildOrdersRequestUrls('');
  const attemptErrors = [];
  const primaryApiUrl = (typeof API_ORIGIN === 'string' && API_ORIGIN) ? (API_ORIGIN + '/orders') : null;

  for (const url of tryUrls){
    try{
      const res = await fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify(requestPayload), mode: 'cors' });
      const rawBody = await res.text().catch(() => '');
      if (!res.ok){
        attemptErrors.push({
          url,
          status: res.status,
          statusText: res.statusText,
          detail: extractOrderErrorDetail(rawBody),
          attempt: 1,
        });
        if (res.status >= 500){
          try{
            const createdFromProbe = await probeCreatedOrderAfterServerError(requestPayload, baseHeaders);
            if (createdFromProbe && createdFromProbe.id != null){
              return { ok: true, createdOrder: createdFromProbe, successfulUrl: url, attemptErrors, viaBackup: false };
            }
          }catch(_){ }
        }
        continue;
      }
      let createdOrder = null;
      try{ createdOrder = rawBody ? JSON.parse(rawBody) : null; }catch(_){ createdOrder = null; }
      return { ok: true, createdOrder, successfulUrl: url, attemptErrors, viaBackup: false };
    }catch(err){
      attemptErrors.push({ url, error: String(err || 'network error'), attempt: 1 });
    }
  }

  try{
    const hasServer5xx = attemptErrors.some((err) => {
      const status = Number(err && err.status);
      return Number.isFinite(status) && status >= 500;
    });
    if (hasServer5xx){
      const existingOrder = await probeCreatedOrderAfterServerError(requestPayload, baseHeaders);
      if (existingOrder && existingOrder.id != null){
        return { ok: true, createdOrder: existingOrder, successfulUrl: primaryApiUrl || '', attemptErrors, viaBackup: false };
      }
    }
  }catch(_){ }

  const backupUrls = buildBackupOrdersRequestUrls();
  for (const url of backupUrls){
    try{
      const res = await fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify([requestPayload]), mode: 'cors' });
      const rawBody = await res.text().catch(() => '');
      let parsed = null;
      try{ parsed = rawBody ? JSON.parse(rawBody) : null; }catch(_){ parsed = null; }
      if (!res.ok){
        attemptErrors.push({
          url,
          status: res.status,
          statusText: res.statusText,
          detail: extractOrderErrorDetail(rawBody),
          backup: true,
        });
        continue;
      }
      const results = Array.isArray(parsed && parsed.results) ? parsed.results : [];
      const okRow = results.find((row) => row && (row.ok === true || row.id != null));
      const saved = Number((parsed && parsed.saved) || 0);
      if (saved > 0 || okRow){
        const backupId = (okRow && okRow.id != null) ? okRow.id : null;
        const createdOrder = backupId != null ? { id: backupId } : null;
        return { ok: true, createdOrder, successfulUrl: url, attemptErrors, viaBackup: true };
      }
      attemptErrors.push({ url, detail: 'backup response without saved orders', backup: true });
    }catch(err){
      attemptErrors.push({ url, error: String(err || 'backup network error'), backup: true });
    }
  }

  return { ok: false, createdOrder: null, successfulUrl: null, attemptErrors, viaBackup: false };
}

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
        let selectedPaymentMethod = null;
        const basePayload = { items: cart, total: cart.reduce((s, i) => {
          const prod = products.find(p => String(p.id ?? p._id) === String(i.id));
          const factor = getItemLineFactor(i, prod);
          return s + (Number(i.meta?.price || 0) * Number(factor || 0));
        }, 0), customer_type: normalizeCustomerType(currentCustomerType) };

        // attach user info if logged in (used to prefill delivery fields)
        const token = getToken();
        if (token) {
          try {
            const profileRes = await fetch(`${API_ORIGIN}/auth/me`, { headers: { 'Authorization': `Bearer ${token}` }, mode: 'cors' });
            if (profileRes.ok) {
              const profile = await profileRes.json();
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
            if (!guestInfo || !guestInfo.email) { try{ checkout.disabled = false; }catch(_){ } return; }
            if (guestInfo.name) basePayload.user_full_name = guestInfo.name;
            if (guestInfo.email) basePayload.user_email = guestInfo.email;
            if (guestInfo.barrio) basePayload.user_barrio = guestInfo.barrio;
            if (guestInfo.calle) basePayload.user_calle = guestInfo.calle;
            if (guestInfo.numero) basePayload.user_numeracion = guestInfo.numero;
          } catch (e) { console.warn('guest info prompt failed', e); }
        }
        if (!basePayload.user_email) {
          try { await showAlert('Necesitamos tu email para enviarte la confirmacion del pedido.'); } catch(_){}
          try { checkout.disabled = false; } catch(_){}
          return;
        }
        // Always confirm delivery address before moving to payment selection.
        const shouldPromptDeliveryAddress = true;
        if (shouldPromptDeliveryAddress) {
          const deliveryInfo = await showDeliveryAddressModal({
            barrio: basePayload.user_barrio || '',
            calle: basePayload.user_calle || '',
            numeracion: basePayload.user_numeracion || '',
            postal_code: basePayload.user_postal_code || '',
            department: basePayload.user_department || '',
            instrucciones: basePayload.user_delivery_notes || ''
          });
          if (!deliveryInfo) {
            try { checkout.disabled = false; } catch(_){}
            return;
          }
          basePayload.user_barrio = deliveryInfo.barrio;
          basePayload.user_calle = deliveryInfo.calle;
          basePayload.user_numeracion = deliveryInfo.numeracion;
          const rawDeliveryPostalCode = normalizePostalCodeToken(
            deliveryInfo.postal_code ||
            deliveryInfo.postcode ||
            deliveryInfo.query_hint ||
            deliveryInfo.full_text ||
            ''
          );
          basePayload.user_department = sanitizeAddressText(
            deliveryInfo.department ||
            findDepartmentInHints([deliveryInfo.query_hint, deliveryInfo.full_text, deliveryInfo.barrio]) ||
            inferDepartmentFromPostalAndHints(rawDeliveryPostalCode, [deliveryInfo.barrio, deliveryInfo.full_text, deliveryInfo.query_hint]) ||
            '',
            80
          );
          basePayload.user_postal_code = selectPostalForDepartment(rawDeliveryPostalCode, basePayload.user_department, [
            deliveryInfo.query_hint,
            deliveryInfo.full_text,
            deliveryInfo.barrio
          ]);
          basePayload.user_query_hint = sanitizeAddressLongText(
            deliveryInfo.query_hint || deliveryInfo.full_text || buildAddressDisplay(deliveryInfo),
            120
          );
          {
            const latNum = Number(deliveryInfo && deliveryInfo.lat);
            const lonNum = Number(deliveryInfo && deliveryInfo.lon);
            if (Number.isFinite(latNum)) basePayload.user_lat = Number(latNum.toFixed(6));
            if (Number.isFinite(lonNum)) basePayload.user_lon = Number(lonNum.toFixed(6));
          }
          basePayload.user_address = sanitizeAddressLongText(deliveryInfo.full_text || buildAddressDisplay(deliveryInfo), 200);
          basePayload.user_address_label = sanitizeAddressAlias(deliveryInfo.label || '');
          basePayload.user_delivery_notes = sanitizeDeliveryNotes(deliveryInfo.instrucciones || '');
        }
        if (!basePayload.user_barrio || !basePayload.user_calle || !basePayload.user_numeracion) {
          try { await showAlert('Necesitamos dirección de entrega (barrio, calle y numeración).'); } catch(_){}
          try { checkout.disabled = false; } catch(_){}
          return;
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
              const productCode = getProductCodeFromObj(prod);
              if (productCode) {
                meta.code = productCode;
                meta.codigo = productCode;
              }
              if (!meta.name && prod) meta.name = String(prod.nombre || prod.name || '').trim();
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
          const deliveryNotes = sanitizeDeliveryNotes(basePayload.user_delivery_notes || '');
          if (deliveryNotes){
            payload.user_delivery_notes = deliveryNotes;
            payload.delivery_notes = deliveryNotes;
          }
          if (basePayload.user_address){
            payload.user_address = sanitizeAddressLongText(basePayload.user_address, 200);
          }
          // If logged-in, include a lightweight preview from the profile we fetched above
          if (basePayload.user_full_name || basePayload.user_email) {
            payload._token_preview = payload._token_preview || { name: basePayload.user_full_name || null, email: basePayload.user_email || null };
            if (deliveryNotes) payload._token_preview.delivery_notes = deliveryNotes;
          }
          if (!payload._token_preview || typeof payload._token_preview !== 'object') payload._token_preview = {};
          if (basePayload.user_barrio) payload._token_preview.barrio = String(basePayload.user_barrio || '').trim();
          if (basePayload.user_calle) payload._token_preview.calle = String(basePayload.user_calle || '').trim();
          if (basePayload.user_numeracion) payload._token_preview.numeracion = String(basePayload.user_numeracion || '').trim();
          if (basePayload.user_postal_code) payload._token_preview.postal_code = normalizePostalCodeToken(basePayload.user_postal_code);
          if (basePayload.user_department) payload._token_preview.department = sanitizeAddressText(basePayload.user_department, 80);
          if (basePayload.user_query_hint) payload._token_preview.query_hint = sanitizeAddressLongText(basePayload.user_query_hint, 120);
          if (basePayload.user_address) payload._token_preview.user_address = sanitizeAddressLongText(basePayload.user_address, 200);
          if (basePayload.user_address_label) payload._token_preview.address_label = sanitizeAddressAlias(basePayload.user_address_label);
          payload._token_preview.address = {
            barrio: String(basePayload.user_barrio || '').trim(),
            calle: String(basePayload.user_calle || '').trim(),
            numeracion: String(basePayload.user_numeracion || '').trim(),
            postal_code: normalizePostalCodeToken(basePayload.user_postal_code || ''),
            department: sanitizeAddressText(basePayload.user_department || '', 80),
            query_hint: sanitizeAddressLongText(basePayload.user_query_hint || basePayload.user_address || '', 120),
            direccion: sanitizeAddressLongText(basePayload.user_address || '', 200)
          };
          if (Number.isFinite(Number(basePayload.user_lat))) payload._token_preview.address.lat = Number(basePayload.user_lat);
          if (Number.isFinite(Number(basePayload.user_lon))) payload._token_preview.address.lon = Number(basePayload.user_lon);
        }catch(e){}
        try{
          const deliverySchedulePreview = computeCheckoutDeliverySchedule(payload);
          if (deliverySchedulePreview.scheduled_delivery_date) payload.scheduled_delivery_date = deliverySchedulePreview.scheduled_delivery_date;
          payload.delivery_cutoff_applied = !!deliverySchedulePreview.delivery_cutoff_applied;
          payload.delivery_timezone = deliverySchedulePreview.delivery_timezone || '';
          payload.delivery_cutoff_hour = deliverySchedulePreview.delivery_cutoff_hour;
        }catch(_){ }
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
        const confirmCheckout = await showCheckoutConfirmModal(payload, null);
        if (!confirmCheckout){
          try { checkout.disabled = false; } catch(_){}
          return;
        }
        selectedPaymentMethod = await showPaymentMethodModal();
        if (!selectedPaymentMethod){
          try { checkout.disabled = false; } catch(_){}
          return;
        }
        payload.payment_method = selectedPaymentMethod === 'mercadopago' ? 'mercadopago' : 'cash';
        payload.payment_status = selectedPaymentMethod === 'mercadopago' ? 'mp_pending' : 'cash_pending';

      const btn = document.getElementById('checkoutBtn');
      btn.disabled = true;

      // Attach Authorization header when token present
      const authToken = getToken();
      const baseHeaders = { 'Content-Type': 'application/json' };
      if (authToken) baseHeaders['Authorization'] = `Bearer ${authToken}`;
      try{ console.debug('[checkout] authToken present?', !!authToken, authToken ? ('***'+authToken.slice(-10)) : null, 'headers', baseHeaders); }catch(_){ }
      const submitResult = await submitOrderPayload(payload, baseHeaders);
      const succeeded = !!(submitResult && submitResult.ok);
      let createdOrder = submitResult && submitResult.createdOrder ? submitResult.createdOrder : null;
      let successfulUrl = submitResult && submitResult.successfulUrl ? submitResult.successfulUrl : null;
      const usedBackup = !!(submitResult && submitResult.viaBackup);
      const _attemptErrors = Array.isArray(submitResult && submitResult.attemptErrors) ? submitResult.attemptErrors : [];

      try {
        if (succeeded) {
          if (usedBackup) {
            try{ showToast('Pedido enviado por canal de respaldo.', 3500); }catch(_){ }
          }
          if (selectedPaymentMethod === 'mercadopago') {
            const orderId = (createdOrder && createdOrder.id) ? createdOrder.id : null;
            if (!orderId) {
              await showAlert('El pedido se creó, pero no pudimos preparar el pago de Mercado Pago.');
              clearCart(); closeCart();
              return;
            }

            const preferencePayload = {
              order_id: orderId,
              external_reference: String(orderId),
              total: Number(payload.total || 0),
              items: (payload.items || []).map(i => {
                const prod = products.find(p => String(p.id ?? p._id) === String(i.id));
                const factor = getItemLineFactor(i, prod);
                const lineTotal = Number(i?.meta?.price || 0) * Number(factor || 0);
                return {
                  id: i.id,
                  title: String(i?.meta?.name || ('Producto ' + String(i.id))),
                  quantity: 1,
                  unit_price: Number(lineTotal.toFixed(2)),
                  currency_id: 'ARS'
                };
              }).filter(i => Number(i.unit_price) > 0),
              payer: {
                name: payload.user_full_name || '',
                email: payload.user_email || ''
              }
            };
            if (!preferencePayload.items.length && Number(preferencePayload.total || 0) > 0) {
              preferencePayload.items = [{
                id: 'order-' + String(orderId),
                title: 'Pedido #' + String(orderId),
                quantity: 1,
                unit_price: Number(Number(preferencePayload.total).toFixed(2)),
                currency_id: 'ARS'
              }];
            }

            try{
              if (location && location.protocol && location.protocol.startsWith('http') && location.origin) {
                const returnPathRaw = String(location.pathname || '/catalogo').trim() || '/catalogo';
                const returnPath = returnPathRaw.startsWith('/') ? returnPathRaw : ('/' + returnPathRaw);
                preferencePayload.back_urls = {
                  success: location.origin + returnPath + '?payment=success',
                  failure: location.origin + returnPath + '?payment=failure',
                  pending: location.origin + returnPath + '?payment=pending'
                };
              }
            }catch(_){ }

            const prefUrls = [];
            try{
              if (successfulUrl) {
                const base = new URL(successfulUrl, location.href).origin;
                prefUrls.push(base + '/payments/mercadopago/preference');
              }
            }catch(_){ }
            try{
              const pageOrigin = (location && location.protocol && location.protocol.startsWith('http') && location.origin) ? location.origin : null;
              if (typeof API_ORIGIN === 'string' && API_ORIGIN) prefUrls.push(API_ORIGIN + '/payments/mercadopago/preference');
              // Avoid noisy 405s on static hosts: only try page origin when it matches API_ORIGIN.
              if (pageOrigin && (!API_ORIGIN || pageOrigin === API_ORIGIN)) {
                prefUrls.push(pageOrigin + '/payments/mercadopago/preference');
              }
            }catch(_){ }
            prefUrls.push('/payments/mercadopago/preference');

            const seenPref = new Set();
            const orderedPrefUrls = prefUrls.filter(u => { if(!u || seenPref.has(u)) return false; seenPref.add(u); return true; });
            let pref = null;
            const prefErrors = [];
            for (const prefUrl of orderedPrefUrls){
              try{
                const prefRes = await fetch(prefUrl, { method: 'POST', headers: baseHeaders, body: JSON.stringify(preferencePayload), mode: 'cors' });
                let prefJson = null;
                let prefText = '';
                try{
                  const ct = String(prefRes.headers.get('content-type') || '').toLowerCase();
                  if (ct.includes('application/json')) {
                    prefJson = await prefRes.json().catch(() => null);
                  } else {
                    prefText = await prefRes.text().catch(() => '');
                    try { prefJson = prefText ? JSON.parse(prefText) : null; } catch(_){ }
                  }
                }catch(_){ }
                if (!prefRes.ok) {
                  let reason = '';
                  try{
                    reason = String((prefJson && (prefJson.detail || prefJson.message || prefJson.error)) || prefText || '').trim();
                  }catch(_){ reason = ''; }
                  prefErrors.push(`[${prefRes.status}] ${reason || 'respuesta no exitosa'}`);
                  continue;
                }
                if (prefJson && (prefJson.init_point || prefJson.sandbox_init_point)) {
                  pref = prefJson;
                  break;
                }
                prefErrors.push('Respuesta de MP sin init_point');
              }catch(err){
                prefErrors.push(String(err || 'error de red'));
              }
            }

            if (pref && (pref.init_point || pref.sandbox_init_point)) {
              clearCart(); closeCart();
              const target = pref.init_point || pref.sandbox_init_point;
              window.location.href = target;
              return;
            }

            const prefDetail = prefErrors.filter(Boolean).slice(0, 3).join(' | ');
            await showAlert(`Pedido #${orderId} creado, pero no pudimos abrir Mercado Pago.${prefDetail ? ('\n\nDetalle: ' + prefDetail) : ''}`, 'warning');
            clearCart(); closeCart();
            return;
          }

          // efectivo
          const deliverySummary = formatDeliveryScheduleSummary(computeCheckoutDeliverySchedule(createdOrder || payload));
          const successMessage = deliverySummary
            ? ('Pedido enviado — entrega programada: ' + deliverySummary + '.')
            : 'Pedido enviado — el panel de administración recibirá la orden.';
          await showAlert(successMessage);
          clearCart(); closeCart();
        } else {
          // graceful fallback: keep el carrito (NO WhatsApp), mostrar modal con opciones al usuario
          console.warn('Checkout failed — showing fallback modal and keeping cart locally.', _attemptErrors);
          try{ console.error('[checkout] attempts', _attemptErrors); }catch(_){ }
          // show modal and persist the failed payload so the user can retry later
          try{ showOrderModal(payload, _attemptErrors); saveFailedOrder(payload); }catch(e){ showOrderModal(payload, _attemptErrors); }
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
  function showOrderModal(payload, attemptErrors = []){
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
      const errors = Array.isArray(attemptErrors) ? attemptErrors.slice(0, 3) : [];
      const errorsHtml = errors.map((err) => {
        const status = err && err.status != null ? ('[' + String(err.status) + '] ') : '';
        const url = err && err.url ? String(err.url) : '';
        const detailRaw = err && (err.detail || err.error || err.statusText) ? String(err.detail || err.error || err.statusText) : '';
        const detail = detailRaw ? (' - ' + detailRaw) : '';
        return `<li>${escapeHtml(status + url + detail)}</li>`;
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
            ${errorsHtml ? `<div class="om-errors"><strong>Errores:</strong><ul>${errorsHtml}</ul></div>` : ''}
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
        .order-modal .om-errors{margin-top:10px;padding:10px;border-radius:10px;background:rgba(12,74,110,0.08);font-size:12px;color:#0b223f}
        .order-modal .om-errors ul{margin:6px 0 0;padding-left:16px}
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

    const authToken = getToken();
    const baseHeaders = { 'Content-Type': 'application/json' };
    if (authToken) baseHeaders['Authorization'] = `Bearer ${authToken}`;
    const submitResult = await submitOrderPayload(payload, baseHeaders);
    if (submitResult && submitResult.ok) {
      if (submitResult.viaBackup) {
        console.warn('Order reattempt stored through /backup-orders fallback.');
      }
      return true;
    }
    try{
      console.error('Order reattempt failed', submitResult && submitResult.attemptErrors ? submitResult.attemptErrors : []);
    }catch(_){ }
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
      const safePayload = buildSanitizedOrderPayload(payload);
      existing.push({ payload: safePayload, ts: Date.now() });
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
      const payloads = list.map(r => buildSanitizedOrderPayload(r.payload));
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
  document.addEventListener('pointerdown', (ev)=>{
    const drawer = document.getElementById('cartDrawer');
    const fab = document.getElementById('cartButton');
    if(!drawer || drawer.getAttribute('aria-hidden')==='true') return;
    if(ev.target.closest && (
      ev.target.closest('#cartDrawer') ||
      ev.target.closest('#cartButton') ||
      ev.target.closest('.__pay_overlay') ||
      ev.target.closest('#__order_modal') ||
      ev.target.closest('.__dialog_overlay')
    )) return;
    closeCart();
  });
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

function getTokenEmail(){
  try{
    const token = getToken();
    if (!token) return null;
    const payload = parseJwt(token) || {};
    const email = payload.sub || payload.email || null;
    return email ? String(email).trim().toLowerCase() : null;
  }catch(_){ return null; }
}

function getOrderEmail(order){
  if (!order || typeof order !== 'object') return null;
  try{
    const direct = order.user_email || order.userEmail;
    if (direct) return String(direct).trim().toLowerCase();
  }catch(_){ }
  try{
    const preview = order._token_preview || order.token_preview || null;
    const email = preview && (preview.email || preview.sub);
    if (email) return String(email).trim().toLowerCase();
  }catch(_){ }
  return null;
}

function normalizeOrderItemForCart(item){
  if (!item || typeof item !== 'object') return null;
  const idRaw = item.id ?? item.product_id ?? item.productId ?? null;
  if (idRaw === null || idRaw === undefined || String(idRaw).trim() === '') return null;
  const qtyRaw = Number(item.qty ?? item.quantity ?? 1);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
  const meta = (item.meta && typeof item.meta === 'object') ? Object.assign({}, item.meta) : {};
  const normalized = {
    id: String(idRaw),
    qty,
    meta
  };
  normalized.key = String(item.key || meta.key || getCartKey(normalized));
  if (!normalized.meta.name) {
    const prod = products.find(p => String(p.id ?? p._id) === normalized.id);
    if (prod) normalized.meta.name = prod.nombre || prod.name || normalized.id;
  }
  return normalized;
}

async function fetchOrdersSnapshot(token, { limit = 200, source = 'web' } = {}){
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const params = new URLSearchParams();
  if (limit != null) params.set('limit', String(limit));
  if (source) params.set('source', String(source));
  const query = params.toString() ? ('?' + params.toString()) : '';
  const tryUrls = buildOrdersRequestUrls(query);

  for (const url of tryUrls){
    try{
      const res = await fetch(url, { method: 'GET', headers, mode: 'cors', cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data)) return data;
    }catch(_){ }
  }
  return [];
}
async function fetchOrdersForRepeat(token){
  return fetchOrdersSnapshot(token, { limit: 200, source: 'web' });
}
async function fetchOrdersForAccount(token){
  const all = await fetchOrdersSnapshot(token, { limit: 300, source: null });
  if (Array.isArray(all) && all.length) return all;
  return fetchOrdersSnapshot(token, { limit: 300, source: 'web' });
}

function updateRepeatOrderButton(){
  const btn = document.getElementById('repeatLastOrderBtn');
  if (!btn) return;
  const email = getTokenEmail();
  if (!email){
    btn.hidden = true;
    btn.disabled = true;
    return;
  }
  btn.hidden = false;
  btn.disabled = false;
  btn.textContent = 'Repetir último pedido';
}

function initCatalogHeaderLogo(){
  try{
    const link = document.querySelector('.site-header .brand-logo');
    const img = document.getElementById('siteBrandLogo');
    if (!link || !img) return;

    const fallbackSrcs = [
      'images/distriar.png',
      './images/distriar.png',
      '/images/distriar.png',
      '/catalogo/images/distriar.png',
      'frontend/images/distriar.png',
      '/frontend/images/distriar.png'
    ];
    let idx = 0;
    const tried = new Set();

    const tryNext = () => {
      while (idx < fallbackSrcs.length) {
        const next = String(fallbackSrcs[idx++] || '').trim();
        if (!next || tried.has(next)) continue;
        tried.add(next);
        img.setAttribute('src', next);
        return;
      }
      link.classList.add('is-broken');
      img.removeEventListener('error', onError);
    };

    const onError = () => { tryNext(); };
    img.addEventListener('error', onError);
    img.addEventListener('load', () => { link.classList.remove('is-broken'); });

    const current = String(img.getAttribute('src') || '').trim();
    if (current) tried.add(current);
    if (img.complete && !img.naturalWidth) {
      tryNext();
    }
  }catch(_){ }
}

async function loadOrderIntoCart(order, { sourceLabel = 'pedido', askBeforeReplace = true } = {}){
  const items = (Array.isArray(order?.items) ? order.items : [])
    .map(normalizeOrderItemForCart)
    .filter(Boolean);
  if (!items.length){
    await showAlert('Este pedido no tiene ítems reutilizables.', 'warning');
    return false;
  }
  const currentCart = readCart();
  if (askBeforeReplace && Array.isArray(currentCart) && currentCart.length){
    const ok = await showConfirm('Tu carrito actual se reemplazará por este pedido. ¿Continuar?', 'warning');
    if (!ok) return false;
  }
  writeCart(items);
  renderCart();
  openCart();
  showToast('Cargamos tu ' + String(sourceLabel || 'pedido') + ' en el carrito.', 3200);
  return true;
}

async function repeatLastOrder(){
  const btn = document.getElementById('repeatLastOrderBtn');
  const token = getToken();
  const email = getTokenEmail();
  if (!token || !email){
    await showAlert('Inicia sesión para repetir un pedido anterior.', 'warning');
    return;
  }

  const previousText = btn ? btn.textContent : '';
  try{
    if (btn){ btn.disabled = true; btn.textContent = 'Buscando pedido...'; }
    const rows = await fetchOrdersForRepeat(token);
    const ownOrders = (rows || []).filter(r => getOrderEmail(r) === email);
    ownOrders.sort((a, b) => {
      const ta = new Date(a && a.created_at ? a.created_at : 0).getTime();
      const tb = new Date(b && b.created_at ? b.created_at : 0).getTime();
      return tb - ta;
    });
    const latest = ownOrders[0];
    if (!latest){
      await showAlert('No encontramos pedidos anteriores para tu cuenta.', 'info');
      return;
    }
    await loadOrderIntoCart(latest, { sourceLabel: 'último pedido', askBeforeReplace: true });
  }catch(e){
    console.warn('repeatLastOrder failed', e);
    await showAlert('No se pudo repetir el último pedido en este momento.', 'error');
  }finally{
    if (btn){
      btn.disabled = false;
      btn.textContent = previousText || 'Repetir último pedido';
    }
  }
}

function formatOrderDateLabel(value){
  try{
    if (!value) return '-';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '-';
    return dt.toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }catch(_){ return '-'; }
}
function humanizeTokenLabel(raw){
  const base = String(raw || '').trim();
  if (!base) return '-';
  return base
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b([a-z\u00e0-\u00ff])/g, (m, c) => c.toUpperCase());
}
function normalizeOrderStatusKey(value){
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}
function formatOrderStatusLabel(value){
  const key = normalizeOrderStatusKey(value);
  if (!key) return '-';
  const map = {
    nuevo: 'Nuevo',
    new: 'Nuevo',
    visto: 'Visto',
    seen: 'Visto',
    preparando: 'Preparando',
    preparing: 'Preparando',
    en_camino: 'En camino',
    delivering: 'En camino',
    entregado: 'Entregado',
    delivered: 'Entregado',
    cancelado: 'Cancelado',
    cancelled: 'Cancelado',
    canceled: 'Cancelado'
  };
  return map[key] || humanizeTokenLabel(key);
}
function normalizePaymentMethodKey(value){
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}
function formatPaymentMethodLabel(value){
  const key = normalizePaymentMethodKey(value);
  if (!key) return '-';
  const map = {
    mercadopago: 'Mercado Pago',
    mp: 'Mercado Pago',
    cash: 'Efectivo',
    efectivo: 'Efectivo',
    transfer: 'Transferencia',
    transferencia: 'Transferencia',
    card: 'Tarjeta'
  };
  return map[key] || humanizeTokenLabel(key);
}
function normalizePaymentStatusKey(value){
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}
function formatPaymentStatusLabel(value, methodValue = ''){
  const key = normalizePaymentStatusKey(value);
  if (!key) return '-';
  const method = normalizePaymentMethodKey(methodValue);
  const map = {
    mp_pending: 'Pendiente de pago',
    cash_pending: 'Pendiente contra entrega',
    pending: 'Pendiente',
    in_process: 'En proceso',
    approved: 'Aprobado',
    accredited: 'Aprobado',
    paid: 'Pagado',
    rejected: 'Rechazado',
    failed: 'Rechazado',
    failure: 'Rechazado',
    cancelled: 'Cancelado',
    canceled: 'Cancelado',
    refunded: 'Reintegrado'
  };
  if (map[key]) return map[key];
  if (method === 'cash' && key === 'pending') return 'Pendiente contra entrega';
  return humanizeTokenLabel(key);
}
function formatOrderPaymentLabel(methodValue, statusValue){
  const methodLabel = formatPaymentMethodLabel(methodValue);
  const statusLabel = formatPaymentStatusLabel(statusValue, methodValue);
  if (!methodLabel || methodLabel === '-') return statusLabel;
  if (!statusLabel || statusLabel === '-' || statusLabel === methodLabel) return methodLabel;
  return methodLabel + ' - ' + statusLabel;
}
function getOrderDateKey(value){
  try{
    if (!value) return '';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '';
    const y = String(dt.getFullYear());
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }catch(_){ return ''; }
}
function formatDateKeyAsDmy(value){
  const key = String(value || '').trim();
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return m[3] + '/' + m[2] + '/' + m[1];
}
function parseDateFilterInput(value){
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, '').replace(/[.\-]/g, '/');
  let day = 0;
  let month = 0;
  let year = 0;
  let m = compact.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m){
    day = Number(m[1]);
    month = Number(m[2]);
    year = Number(m[3]);
  } else {
    m = compact.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) return null;
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  }
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;
  if (year < 1900 || year > 2500) return null;
  const dt = new Date(year, month - 1, day);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getFullYear() !== year || (dt.getMonth() + 1) !== month || dt.getDate() !== day) return null;
  return String(year) + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
function buildOrderSearchIndex(order){
  try{
    const id = String(order?.id ?? '').trim();
    const address = getOrderAddressLabel(order);
    const status = formatOrderStatusLabel(order?.status || '');
    const payment = formatOrderPaymentLabel(order?.payment_method || '', order?.payment_status || '');
    const itemNames = (Array.isArray(order?.items) ? order.items : []).map(resolveOrderItemName).join(' ');
    return [id, address, status, payment, itemNames].join(' ').toLowerCase();
  }catch(_){ return ''; }
}
function buildCheckoutAddressLabel(payload){
  try{
    const street = [String(payload?.user_calle || '').trim(), String(payload?.user_numeracion || '').trim()].filter(Boolean).join(' ');
    const barrio = String(payload?.user_barrio || '').trim();
    const department = String(payload?.user_department || '').trim();
    const postalCode = normalizePostalCodeToken(payload?.user_postal_code || '');
    const parts = [street, barrio, department, postalCode].filter(Boolean);
    return parts.join(', ') || '-';
  }catch(_){ return '-'; }
}
function normalizeIsoDateKey(value){
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  return match[1] + '-' + match[2] + '-' + match[3];
}
function dateToIsoKey(dateValue){
  try{
    const dt = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (Number.isNaN(dt.getTime())) return '';
    return String(dt.getFullYear()) + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  }catch(_){ return ''; }
}
function formatIsoDateKeyWithWeekday(value){
  const key = normalizeIsoDateKey(value);
  if (!key) return '';
  try{
    const parts = key.split('-');
    const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (Number.isNaN(dt.getTime())) return key;
    const weekday = dt.toLocaleDateString('es-AR', { weekday: 'long' });
    const day = dt.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return weekday.charAt(0).toUpperCase() + weekday.slice(1) + ' ' + day;
  }catch(_){ return key; }
}
function computeCheckoutDeliverySchedule(payload){
  const rawHour = Number(payload?.delivery_cutoff_hour ?? ORDER_CUTOFF_HOUR);
  const cutoffHour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, Math.trunc(rawHour))) : ORDER_CUTOFF_HOUR;
  const now = new Date();
  const explicitCutoffRaw = payload?.delivery_cutoff_applied;
  const hasExplicitCutoff = explicitCutoffRaw !== undefined && explicitCutoffRaw !== null && String(explicitCutoffRaw).trim() !== '';
  const cutoffApplied = hasExplicitCutoff
    ? (explicitCutoffRaw === true || String(explicitCutoffRaw).trim().toLowerCase() === 'true')
    : (now.getHours() >= cutoffHour);
  const scheduledFromPayload = normalizeIsoDateKey(payload?.scheduled_delivery_date);
  const scheduledDate = scheduledFromPayload || dateToIsoKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + (cutoffApplied ? 2 : 1)));
  return {
    scheduled_delivery_date: scheduledDate,
    delivery_cutoff_applied: cutoffApplied,
    delivery_cutoff_hour: cutoffHour,
    delivery_timezone: String(payload?.delivery_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '')
  };
}
function formatDeliveryScheduleSummary(scheduleMeta){
  const dateLabel = formatIsoDateKeyWithWeekday(scheduleMeta?.scheduled_delivery_date);
  if (!dateLabel) return '';
  const cutoffHour = Number(scheduleMeta?.delivery_cutoff_hour);
  const cutoffLabel = Number.isFinite(cutoffHour) ? String(Math.trunc(cutoffHour)).padStart(2, '0') + ':00' : '18:00';
  if (scheduleMeta?.delivery_cutoff_applied) {
    return dateLabel + ' (pedido despues de las ' + cutoffLabel + ')';
  }
  return dateLabel;
}
async function showCheckoutConfirmModal(payload, selectedPaymentMethod){
  try{
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const previewItems = items.slice(0, 8);
    const itemsHtml = previewItems.map((it) => {
      const id = String(it?.id ?? it?.product_id ?? it?.productId ?? '');
      const prod = products.find(p => String(p.id ?? p._id) === id);
      const unitType = getItemUnitType(it, prod);
      const qtyLabel = formatQtyLabel(it?.qty ?? 1, unitType, it?.meta || {});
      const lineFactor = getItemLineFactor(it, prod);
      const lineTotal = Number(it?.meta?.price || 0) * Number(lineFactor || 0);
      const name = resolveOrderItemName(it);
      return `<li class="__checkout_item"><span>${escapeHtml(name)}<small>x${escapeHtml(String(qtyLabel))}</small></span><strong>$${escapeHtml(lineTotal.toFixed(2))}</strong></li>`;
    }).join('');
    const remaining = Math.max(0, items.length - previewItems.length);
    const paymentPreviewLabel = selectedPaymentMethod
      ? formatOrderPaymentLabel(selectedPaymentMethod, payload?.payment_status || '')
      : 'Se elige en el siguiente paso';
    const paymentLabel = escapeHtml(paymentPreviewLabel);
    const totalLabel = '$' + escapeHtml(Number(payload?.total || 0).toFixed(2));
    const addressLabel = escapeHtml(buildCheckoutAddressLabel(payload));
    const notesValue = sanitizeDeliveryNotes(payload?.user_delivery_notes || payload?.delivery_notes || payload?._token_preview?.delivery_notes || '');
    const notesLabel = escapeHtml(notesValue || 'Sin indicaciones');
    const nameLabel = escapeHtml(String(payload?.user_full_name || 'Cliente'));
    const emailLabel = escapeHtml(String(payload?.user_email || '-'));
    const deliverySchedule = computeCheckoutDeliverySchedule(payload);
    const deliveryScheduleLabel = escapeHtml(formatDeliveryScheduleSummary(deliverySchedule) || 'A confirmar');
    const waMessage = encodeURIComponent('Hola, necesito ayuda para finalizar mi pedido desde el checkout.');
    const waHref = 'https://wa.me/' + SUPPORT_WHATSAPP_E164 + '?text=' + waMessage;
    const emailBody = [
      'Hola equipo de DistriAr,',
      '',
      'Necesito ayuda con mi pedido.',
      '',
      'Nombre: ' + String(payload?.user_full_name || ''),
      'Email: ' + String(payload?.user_email || ''),
      'Direccion: ' + buildCheckoutAddressLabel(payload),
      'Instrucciones: ' + (notesValue || 'Sin indicaciones'),
      'Total aproximado: ' + Number(payload?.total || 0).toFixed(2),
      '',
      'Gracias.'
    ].join('\n');
    const emailHref = 'mailto:' + SUPPORT_EMAIL +
      '?subject=' + encodeURIComponent('Ayuda con mi pedido') +
      '&body=' + encodeURIComponent(emailBody);
    const html = `
      <div class="__checkout_confirm">
        <div class="__checkout_meta">
          <div><strong>Cliente:</strong> ${nameLabel}</div>
          <div><strong>Email:</strong> ${emailLabel}</div>
          <div><strong>Entrega:</strong> ${addressLabel}</div>
          <div><strong>Entrega programada:</strong> ${deliveryScheduleLabel}</div>
          <div><strong>Instrucciones:</strong> ${notesLabel}</div>
          <div><strong>Pago:</strong> ${paymentLabel}</div>
        </div>
        <ul class="__checkout_items">${itemsHtml || '<li class="__checkout_item __checkout_item_empty">Sin ítems</li>'}</ul>
        ${remaining > 0 ? `<div class="__checkout_more">+${escapeHtml(String(remaining))} ítems más</div>` : ''}
        <div class="__checkout_total">Total: <span>${totalLabel}</span></div>
        <aside class="__checkout_help">
          <div class="__checkout_help_title">¿Necesitas ayuda?</div>
          <div class="__checkout_help_text">WhatsApp ${escapeHtml(SUPPORT_WHATSAPP_DISPLAY)} · ${escapeHtml(SUPPORT_EMAIL)}</div>
          <div class="__checkout_help_actions">
            <a class="btn btn-ghost __checkout_help_link" href="${escapeHtml(waHref)}" target="_blank" rel="noopener">WhatsApp</a>
            <a class="btn btn-ghost __checkout_help_link" href="${escapeHtml(emailHref)}">Email</a>
            <a class="btn btn-ghost __checkout_help_link" href="index.html#contacto">Contacto</a>
          </div>
        </aside>
      </div>
    `;
    return await showDialog({
      title: 'Confirmar pedido',
      html,
      type: 'info',
      buttons: [
        { label: 'Cancelar', value: false },
        { label: 'Confirmar pedido', value: true, primary: true }
      ]
    });
  }catch(_){
    return showConfirm('¿Confirmas el envío de este pedido?', 'warning');
  }
}
function getOrderAddressLabel(order){
  try{
    const street = [String(order?.user_calle || '').trim(), String(order?.user_numeracion || '').trim()].filter(Boolean).join(' ');
    const barrio = String(order?.user_barrio || '').trim();
    const department = String(order?.user_department || '').trim();
    const postalCode = normalizePostalCodeToken(order?.user_postal_code || '');
    const parts = [street, barrio, department, postalCode].filter(Boolean);
    return parts.join(', ') || '-';
  }catch(_){ return '-'; }
}
function resolveOrderItemName(item){
  try{
    const metaName = item?.meta?.name || item?.meta?.nombre || item?.meta?.promo_name;
    if (metaName) return String(metaName).trim();
    const pid = item?.id ?? item?.product_id ?? item?.productId ?? null;
    if (pid == null) return 'Producto';
    const prod = products.find(p => String(p.id ?? p._id) === String(pid));
    if (prod) return String(prod.nombre || prod.name || ('Producto ' + String(pid)));
    return 'Producto ' + String(pid);
  }catch(_){ return 'Producto'; }
}
function buildOrderItemsListHtml(order){
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return '<li>Sin ítems</li>';
  const maxVisible = 4;
  const parts = [];
  for (let i = 0; i < Math.min(items.length, maxVisible); i++){
    const it = items[i];
    const qtyRaw = Number(it?.qty ?? it?.quantity ?? 1);
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
    parts.push('<li><span class="__orders_qty">x' + escapeHtml(String(qty)) + '</span>' + escapeHtml(resolveOrderItemName(it)) + '</li>');
  }
  if (items.length > maxVisible){
    parts.push('<li class="__orders_more">+' + escapeHtml(String(items.length - maxVisible)) + ' ítems más</li>');
  }
  return parts.join('');
}
function getOrderDeliveryScheduleMeta(order){
  try{
    const dateKey = normalizeIsoDateKey(order?.scheduled_delivery_date);
    if (!dateKey) return null;
    const rawHour = Number(order?.delivery_cutoff_hour ?? ORDER_CUTOFF_HOUR);
    const cutoffHour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, Math.trunc(rawHour))) : ORDER_CUTOFF_HOUR;
    const cutoffRaw = order?.delivery_cutoff_applied;
    const cutoffApplied = cutoffRaw === true || String(cutoffRaw || '').trim().toLowerCase() === 'true';
    return {
      scheduled_delivery_date: dateKey,
      delivery_cutoff_applied: cutoffApplied,
      delivery_cutoff_hour: cutoffHour,
      delivery_timezone: String(order?.delivery_timezone || '')
    };
  }catch(_){ return null; }
}
function buildOrderCardHtml(order){
  const rawId = String(order?.id ?? '').trim();
  const idLabel = escapeHtml(rawId || '-');
  const dateLabel = escapeHtml(formatOrderDateLabel(order?.created_at));
  const statusLabel = escapeHtml(formatOrderStatusLabel(order?.status || 'nuevo'));
  const totalRaw = Number(order?.total || 0);
  const totalLabel = '$' + escapeHtml(totalRaw.toFixed(2));
  const paymentLabel = escapeHtml(formatOrderPaymentLabel(order?.payment_method || '-', order?.payment_status || '-'));
  const addressLabel = escapeHtml(getOrderAddressLabel(order));
  const deliveryScheduleMeta = getOrderDeliveryScheduleMeta(order);
  const deliveryScheduleLabel = deliveryScheduleMeta ? escapeHtml(formatDeliveryScheduleSummary(deliveryScheduleMeta) || '') : '';
  const repeatable = rawId && Array.isArray(order?.items) && order.items.length > 0;
  return `
    <article class="__order_card">
      <header class="__order_head">
        <div class="__order_title">Pedido #${idLabel}</div>
        <div class="__order_date">${dateLabel}</div>
      </header>
      <div class="__order_meta">
        <span class="__order_chip">Estado: ${statusLabel}</span>
        <span class="__order_chip">Pago: ${paymentLabel}</span>
        <span class="__order_chip __order_total">Total: ${totalLabel}</span>
      </div>
      <div class="__order_address"><strong>Entrega:</strong> ${addressLabel}</div>
      ${deliveryScheduleLabel ? `<div class="__order_address"><strong>Entrega programada:</strong> ${deliveryScheduleLabel}</div>` : ''}
      <ul class="__order_items">${buildOrderItemsListHtml(order)}</ul>
      ${repeatable
        ? `<div class="__order_actions"><button class="btn btn-ghost __order_repeat_btn" data-action="repeat_order" data-order-id="${escapeHtml(rawId)}">Repetir pedido</button></div>`
        : ''}
    </article>
  `;
}
async function showMyOrdersModal(){
  const token = getToken();
  const email = getTokenEmail();
  if (!token || !email){
    await showAlert('Inicia sesión para ver tus pedidos.', 'warning');
    return;
  }
  try{
    ensureGlobalDialogStyles();
    const existing = document.getElementById('__orders_overlay');
    if (existing){
      const d = existing.querySelector('.__dialog');
      existing.classList.add('open');
      if (d) d.classList.add('open');
      document.body.classList.add('__lock_scroll');
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = '__dialog_overlay __orders_overlay';
    overlay.id = '__orders_overlay';
    overlay.style.zIndex = 3390;
    overlay.innerHTML = `
      <div class="__dialog __dialog--info __orders_dialog" role="dialog" aria-modal="true" aria-label="Mis pedidos">
        <div class="dialog-header">
          <span class="dialog-icon">🧾</span>
          <h3>Mis pedidos</h3>
        </div>
        <div class="dialog-body">
          <p class="__orders_hint">Aquí tienes el historial de pedidos de tu cuenta.</p>
          <div class="__orders_toolbar">
            <input id="__orders_search" class="__orders_field __orders_search" type="search" placeholder="Buscar por pedido, producto o dirección" />
            <select id="__orders_status" class="__orders_field">
              <option value="">Estado: todos</option>
            </select>
            <select id="__orders_payment" class="__orders_field">
              <option value="">Pago: todos</option>
            </select>
            <input id="__orders_date" class="__orders_field __orders_date" type="text" inputmode="numeric" placeholder="dd/mm/aaaa" title="Formato: dd/mm/aaaa" aria-label="Filtrar por fecha (día/mes/año)" />
            <button class="btn btn-ghost __orders_clear" data-action="clear_orders_filters">Limpiar</button>
          </div>
          <div id="__orders_list" class="__orders_list">
            <div class="__orders_loading">Cargando pedidos...</div>
          </div>
          <div id="__orders_pager" class="__orders_pager" hidden></div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost" data-action="close">Cerrar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.classList.add('__lock_scroll');
    const dialog = overlay.querySelector('.__dialog');
    requestAnimationFrame(()=>{
      try{
        overlay.classList.add('open');
        if (dialog) dialog.classList.add('open');
      }catch(_){ }
    });

    const close = () => {
      try{ overlay.remove(); window.removeEventListener('keydown', onKey); }catch(_){ }
      try{
        if (!document.getElementById('__orders_overlay')) document.body.classList.remove('__lock_scroll');
      }catch(_){ }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (ev) => { if (!ev.target.closest('.__dialog')) close(); });
    overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);

    const listEl = overlay.querySelector('#__orders_list');
    const pagerEl = overlay.querySelector('#__orders_pager');
    const searchEl = overlay.querySelector('#__orders_search');
    const statusEl = overlay.querySelector('#__orders_status');
    const paymentEl = overlay.querySelector('#__orders_payment');
    const dateEl = overlay.querySelector('#__orders_date');
    const clearFiltersBtn = overlay.querySelector('[data-action="clear_orders_filters"]');
    const rows = await fetchOrdersForAccount(token);
    const ownOrders = (rows || []).filter(r => getOrderEmail(r) === email);
    ownOrders.sort((a, b) => {
      const ta = new Date(a && a.created_at ? a.created_at : 0).getTime();
      const tb = new Date(b && b.created_at ? b.created_at : 0).getTime();
      return tb - ta;
    });

    if (!listEl || !pagerEl) return;
    if (!ownOrders.length){
      listEl.innerHTML = '<div class="__orders_empty">No encontramos pedidos para tu cuenta.</div>';
      pagerEl.hidden = true;
      return;
    }

    const orderById = new Map();
    const indexedRows = ownOrders.map((order, idx) => {
      const idKey = String(order?.id ?? '').trim();
      if (idKey && !orderById.has(idKey)) orderById.set(idKey, order);
      return {
        key: idKey ? (idKey + ':' + String(idx)) : ('row:' + String(idx)),
        order,
        statusKey: normalizeOrderStatusKey(order?.status || ''),
        paymentKey: normalizePaymentMethodKey(order?.payment_method || ''),
        dateKey: getOrderDateKey(order?.created_at),
        searchText: buildOrderSearchIndex(order),
        html: buildOrderCardHtml(order)
      };
    });

    if (statusEl){
      const statusKeys = Array.from(new Set(indexedRows.map(r => r.statusKey).filter(Boolean)));
      statusKeys.sort((a, b) => formatOrderStatusLabel(a).localeCompare(formatOrderStatusLabel(b), 'es-AR'));
      statusEl.innerHTML = '<option value="">Estado: todos</option>' + statusKeys.map((key) =>
        '<option value="' + escapeHtml(key) + '">' + escapeHtml(formatOrderStatusLabel(key)) + '</option>'
      ).join('');
    }
    if (paymentEl){
      const paymentKeys = Array.from(new Set(indexedRows.map(r => r.paymentKey).filter(Boolean)));
      paymentKeys.sort((a, b) => formatPaymentMethodLabel(a).localeCompare(formatPaymentMethodLabel(b), 'es-AR'));
      paymentEl.innerHTML = '<option value="">Pago: todos</option>' + paymentKeys.map((key) =>
        '<option value="' + escapeHtml(key) + '">' + escapeHtml(formatPaymentMethodLabel(key)) + '</option>'
      ).join('');
    }

    const PAGE_SIZE = 10;
    let filteredRows = indexedRows;
    let visibleCount = 0;
    const renderVisibleRows = () => {
      if (!filteredRows.length){
        listEl.innerHTML = '<div class="__orders_empty">No encontramos pedidos con esos filtros.</div>';
        pagerEl.hidden = true;
        visibleCount = 0;
        return;
      }
      const firstCount = Math.min(PAGE_SIZE, filteredRows.length);
      listEl.innerHTML = filteredRows.slice(0, firstCount).map(r => r.html).join('');
      visibleCount = firstCount;
      updatePager();
    };
    const updatePager = () => {
      const remaining = Math.max(0, filteredRows.length - visibleCount);
      pagerEl.hidden = false;
      if (remaining > 0){
        pagerEl.innerHTML = `
          <span class="__orders_progress">Mostrando ${visibleCount} de ${filteredRows.length}</span>
          <button class="btn btn-ghost __orders_more_btn" data-action="load_more_orders">Cargar más (${Math.min(PAGE_SIZE, remaining)})</button>
        `;
        const loadMoreBtn = pagerEl.querySelector('[data-action="load_more_orders"]');
        if (loadMoreBtn){
          loadMoreBtn.addEventListener('click', () => {
            const nextCount = Math.min(visibleCount + PAGE_SIZE, filteredRows.length);
            if (nextCount <= visibleCount) return;
            const nextChunk = filteredRows.slice(visibleCount, nextCount).map(r => r.html).join('');
            if (nextChunk) listEl.insertAdjacentHTML('beforeend', nextChunk);
            visibleCount = nextCount;
            requestAnimationFrame(updatePager);
          });
        }
      } else {
        pagerEl.innerHTML = `<span class="__orders_progress">Mostrando ${visibleCount} de ${filteredRows.length}</span>`;
      }
    };
    const applyFilters = () => {
      const needle = String(searchEl?.value || '').trim().toLowerCase();
      const statusFilter = String(statusEl?.value || '').trim();
      const paymentFilter = String(paymentEl?.value || '').trim();
      const dateRaw = String(dateEl?.value || '').trim();
      const dateFilter = parseDateFilterInput(dateRaw);
      filteredRows = indexedRows.filter((row) => {
        if (needle && !row.searchText.includes(needle)) return false;
        if (statusFilter && row.statusKey !== statusFilter) return false;
        if (paymentFilter && row.paymentKey !== paymentFilter) return false;
        if (dateFilter && row.dateKey !== dateFilter) return false;
        return true;
      });
      renderVisibleRows();
    };
    let filtersRaf = null;
    const scheduleApplyFilters = () => {
      if (filtersRaf) cancelAnimationFrame(filtersRaf);
      filtersRaf = requestAnimationFrame(() => {
        filtersRaf = null;
        applyFilters();
      });
    };
    searchEl?.addEventListener('input', scheduleApplyFilters);
    statusEl?.addEventListener('change', scheduleApplyFilters);
    paymentEl?.addEventListener('change', scheduleApplyFilters);
    const normalizeDateField = () => {
      if (!dateEl) return;
      const parsed = parseDateFilterInput(dateEl.value);
      if (parsed) dateEl.value = formatDateKeyAsDmy(parsed);
    };
    dateEl?.addEventListener('change', () => {
      normalizeDateField();
      scheduleApplyFilters();
    });
    dateEl?.addEventListener('blur', () => {
      normalizeDateField();
      scheduleApplyFilters();
    });
    clearFiltersBtn?.addEventListener('click', () => {
      if (searchEl) searchEl.value = '';
      if (statusEl) statusEl.value = '';
      if (paymentEl) paymentEl.value = '';
      if (dateEl) dateEl.value = '';
      scheduleApplyFilters();
      try{ searchEl?.focus(); }catch(_){ }
    });
    listEl.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-action="repeat_order"]');
      if (!btn) return;
      const orderId = String(btn.getAttribute('data-order-id') || '').trim();
      if (!orderId) return;
      const order = orderById.get(orderId);
      if (!order) return;
      const previousText = btn.textContent;
      try{
        btn.disabled = true;
        btn.textContent = 'Cargando...';
        await loadOrderIntoCart(order, {
          sourceLabel: 'pedido #' + orderId,
          askBeforeReplace: true
        });
      }catch(e){
        console.warn('repeat_order from history failed', e);
        await showAlert('No se pudo repetir este pedido en este momento.', 'warning');
      }finally{
        btn.disabled = false;
        btn.textContent = previousText || 'Repetir pedido';
      }
    });
    requestAnimationFrame(applyFilters);
  }catch(e){
    console.warn('showMyOrdersModal failed', e);
    await showAlert('No se pudieron cargar tus pedidos en este momento.', 'error');
  }
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
    if(!container){ container = document.createElement('div'); container.id='__toast_container'; container.style.position='fixed'; container.style.right='20px'; container.style.bottom='20px'; container.style.zIndex='5300'; container.style.display='flex'; container.style.flexDirection='column'; container.style.gap='8px'; document.body.appendChild(container); }
    if (container.style.zIndex !== '5300') container.style.zIndex = '5300';
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
function ensureGlobalDialogStyles(){
  if (document.getElementById('__global_dialog_styles')) return;
  const s = document.createElement('style'); s.id = '__global_dialog_styles'; s.textContent = `
.__dialog_overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,0.36);backdrop-filter:blur(3px);z-index:3600;opacity:0;pointer-events:none;transition:opacity .18s ease}
.__dialog_overlay.open{opacity:1;pointer-events:auto}
body.__lock_scroll{overflow:hidden}
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
.__dialog textarea{width:100%;padding:10px;border-radius:8px;border:1px solid #e6e9ef;min-height:84px;resize:vertical;font-family:inherit}
.__delivery_dialog{width:620px;max-width:calc(100% - 24px);padding:18px}
.__delivery_dialog .dialog-body{color:var(--deep)}
.__delivery_hint{margin:0 0 12px;color:var(--muted);font-size:14px}
.__delivery_inputs{display:grid;gap:10px}
.__delivery_inputs input{height:42px;border:1px solid rgba(10,34,64,0.12);border-radius:10px;padding:0 12px;font-size:14px;background:linear-gradient(180deg,#fff,#fcfdff)}
.__delivery_inputs textarea{min-height:78px;max-height:180px;resize:vertical;border:1px solid rgba(10,34,64,0.12);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;line-height:1.35;background:linear-gradient(180deg,#fff,#fcfdff)}
.__addr_notes_label{font-size:12px;font-weight:800;letter-spacing:.01em;color:#334155;margin-top:2px}
.__addr_notes_hint{margin:2px 2px 0;color:#64748b;font-size:11px;line-height:1.3}
.__addr_saved_block{margin:0 0 12px;padding:10px;border-radius:12px;background:linear-gradient(180deg,#fff,#f9fbff);border:1px solid rgba(10,34,64,0.08)}
.__addr_saved_title{font-size:12px;font-weight:800;letter-spacing:0.4px;text-transform:uppercase;color:rgba(6,26,43,0.62);margin:0 0 8px}
.__addr_saved_list{display:flex;flex-wrap:wrap;gap:8px}
.__addr_saved_chip{border:1px solid rgba(10,34,64,0.12);background:#fff;border-radius:999px;padding:7px 12px;font-size:13px;font-weight:700;color:var(--deep);cursor:pointer}
.__addr_saved_chip.active{border-color:rgba(242,107,56,0.45);background:linear-gradient(90deg,rgba(242,107,56,0.1),rgba(255,184,77,0.12))}
.__addr_saved_empty{margin:0;color:var(--muted);font-size:13px}
.__addr_check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);margin-top:4px}
.__addr_check input{accent-color:var(--accent)}
.__delivery_selected_card{margin:0 0 12px;padding:11px 12px;border-radius:12px;background:linear-gradient(180deg,#f8fbff,#ffffff);border:1px solid rgba(14,94,184,0.2)}
.__delivery_selected_title{font-size:11px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#2f4e72;margin-bottom:6px}
.__delivery_selected_line{font-size:14px;color:#0f2237;font-weight:700;line-height:1.35}
.__delivery_selected_empty{font-size:13px;color:var(--muted)}
.__delivery_alias_label{font-size:12px;font-weight:800;letter-spacing:.01em;color:#334155;margin-top:2px}
.__delivery_alias_input{height:42px;border:1px solid rgba(10,34,64,0.12);border-radius:10px;padding:0 12px;font-size:14px;background:linear-gradient(180deg,#fff,#fcfdff)}
.__delivery_add_btn{width:100%;justify-content:center}
.__addr_search_overlay{backdrop-filter:blur(5px)}
.__addr_search_dialog{width:700px;max-width:calc(100% - 26px);padding:16px}
.__addr_search_head{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}
.__addr_search_head h3{margin:0 0 3px;font-size:32px;line-height:1.05;font-weight:900;letter-spacing:-0.03em;color:#041124}
.__addr_search_head p{margin:0;font-size:13px;color:#5f7088;font-weight:600}
.__addr_search_back{min-width:38px;height:38px;padding:0;border-radius:10px}
.__addr_search_box{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
.__addr_search_input{height:46px;border:1px solid rgba(10,34,64,0.14);border-radius:12px;padding:0 14px;font-size:16px;background:#fff}
.__addr_search_geo{height:46px;padding:0 14px;border-radius:12px;white-space:nowrap}
.__addr_search_status{margin:8px 0 10px;color:#50637a;font-size:12px;font-weight:700}
.__addr_search_manual_wrap{display:flex;justify-content:flex-start;margin:-2px 0 10px}
.__addr_search_manual{min-height:34px;padding:6px 10px;border-radius:10px;font-size:12px;font-weight:800}
.__addr_search_list{display:flex;flex-direction:column;gap:6px;max-height:45vh;overflow:auto;padding-right:3px}
.__addr_search_item{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;padding:11px;border:1px solid rgba(10,34,64,0.08);border-radius:12px;background:#fff;color:#0f2237;font-weight:700;cursor:pointer}
.__addr_search_item:hover{background:linear-gradient(180deg,#f7faff,#fefefe);border-color:rgba(14,94,184,0.26)}
.__addr_search_pin{font-size:15px;line-height:1.2}
.__addr_search_text{line-height:1.3}
.__addr_map_overlay{backdrop-filter:blur(5px)}
.__addr_map_dialog{width:760px;max-width:calc(100% - 22px);padding:14px}
.__addr_map_head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.__addr_map_head h3{margin:0;font-size:26px;font-weight:900;letter-spacing:-0.02em;color:#03142a}
.__addr_map_canvas{height:380px;border-radius:14px;overflow:hidden;border:1px solid rgba(10,34,64,0.12);background:linear-gradient(180deg,#edf4ff,#dce8f6)}
.__addr_map_canvas iframe{width:100%;height:100%;border:0;display:block}
.__addr_map_help{margin:8px 2px 10px;font-size:12px;font-weight:700;color:#4f6480}
.__addr_map_precision{display:none;margin:-2px 2px 10px;padding:9px 11px;border-radius:11px;border:1px solid rgba(245,158,11,0.45);background:linear-gradient(180deg,rgba(255,248,235,0.98),rgba(255,243,218,0.98));font-size:12px;line-height:1.35;font-weight:800;color:#7c2d12}
.__addr_map_precision.show{display:block}
.__addr_map_address_wrap{margin-bottom:4px}
.__addr_map_address{width:100%;height:44px;border-radius:12px;border:1px solid rgba(10,34,64,0.12);padding:0 12px;background:#fff;font-size:14px;font-weight:700;color:#0f2237}
.__map_pin{background:transparent !important;border:none !important}
.__map_pin span{position:relative;display:block;width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:linear-gradient(180deg,#071427,#192f4f);border:2px solid #ffffff;box-shadow:0 8px 18px rgba(7,20,39,0.34)}
.__map_pin span::after{content:'';position:absolute;width:8px;height:8px;background:#fff;border-radius:50%;top:50%;left:50%;transform:translate(-50%,-50%)}
.__account_dialog{width:900px;max-width:calc(100% - 20px);padding:18px 18px 14px}
.__account_identity{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:12px;background:linear-gradient(90deg,rgba(242,107,56,0.08),rgba(255,184,77,0.1));margin-bottom:12px}
.__account_identity_main{display:flex;align-items:center;gap:12px}
.__account_identity_avatar{width:52px;height:52px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#fff;color:#0b223f;border:1px solid rgba(10,34,64,0.12);box-shadow:0 8px 24px rgba(10,34,64,0.08)}
.__account_identity_avatar svg{width:28px;height:28px}
.__account_name{font-weight:900;font-size:16px;color:var(--deep)}
.__account_email{font-size:13px;color:rgba(6,26,43,0.7)}
.__account_layout{display:grid;grid-template-columns:1.25fr 1fr;gap:12px}
.__account_panel{border:1px solid rgba(10,34,64,0.08);border-radius:12px;background:#fff;padding:12px}
.__account_panel h4{margin:0 0 10px;font-size:14px}
.__account_address_list{display:flex;flex-direction:column;gap:9px;max-height:44vh;overflow:auto;padding-right:4px}
.__account_addr_item{border:1px solid rgba(10,34,64,0.09);border-radius:11px;padding:10px;background:linear-gradient(180deg,#fff,#fcfdff)}
.__account_addr_item.is-default{border-color:rgba(242,107,56,0.38);background:linear-gradient(180deg,rgba(255,244,237,0.92),#fff)}
.__account_addr_top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.__account_addr_label{font-weight:800;color:var(--deep);font-size:13px}
.__account_addr_name{display:flex;align-items:center;gap:6px}
.__account_addr_last{font-size:11px;color:rgba(6,26,43,0.62);font-weight:700}
.__account_addr_badge{font-size:11px;font-weight:800;color:#b45309;background:#fff7ed;border:1px solid rgba(242,107,56,0.3);padding:2px 7px;border-radius:999px}
.__account_addr_line{font-size:13px;color:rgba(6,26,43,0.82);margin-bottom:8px}
.__account_addr_notes{font-size:12px;color:#475569;line-height:1.35;margin:-4px 0 8px}
.__account_addr_actions{display:flex;flex-wrap:wrap;gap:6px}
.__account_addr_actions .btn{padding:6px 10px;border-radius:9px;font-size:12px}
.__account_form{display:grid;gap:9px}
.__account_form input{height:40px;border:1px solid rgba(10,34,64,0.12);border-radius:10px;padding:0 11px}
.__account_form [data-action="add_address"]{width:100%;justify-content:center}
.__account_form_actions{display:flex;gap:8px;justify-content:flex-end}
.__account_empty{font-size:13px;color:var(--muted);padding:12px;border:1px dashed rgba(10,34,64,0.2);border-radius:10px;background:#fcfdff}
.__account_subtle{font-size:12px;color:var(--muted)}
.__account_header_actions{display:flex;gap:8px;align-items:center}
.__account_header_actions .btn{padding:7px 10px;border-radius:9px}
.__account_dialog .btn,
.__orders_dialog .btn,
.__delivery_dialog .btn{
  position:relative;
  min-height:38px;
  padding:9px 14px;
  border-radius:12px;
  border:1px solid transparent;
  font-weight:800;
  letter-spacing:0.1px;
  transition:transform .14s cubic-bezier(.2,.9,.3,1), box-shadow .18s ease, border-color .18s ease, background .18s ease, filter .16s ease;
}
.__account_dialog .btn:active,
.__orders_dialog .btn:active,
.__delivery_dialog .btn:active{
  transform:translateY(0);
  box-shadow:0 6px 14px rgba(24,52,92,0.14);
}
.__account_dialog .btn:focus-visible,
.__orders_dialog .btn:focus-visible,
.__delivery_dialog .btn:focus-visible{
  outline:3px solid rgba(242,107,56,0.22);
  outline-offset:2px;
}
.__account_dialog .btn.btn-ghost,
.__orders_dialog .btn.btn-ghost,
.__delivery_dialog .btn.btn-ghost{
  background:linear-gradient(180deg,#ffffff,#edf4ff) !important;
  color:#16335a !important;
  border-color:rgba(74,107,158,0.36) !important;
  box-shadow:0 1px 0 rgba(255,255,255,0.92) inset, 0 8px 18px rgba(22,51,90,0.12);
}
.__account_dialog .btn.btn-ghost:hover,
.__orders_dialog .btn.btn-ghost:hover,
.__delivery_dialog .btn.btn-ghost:hover{
  transform:translateY(-1px);
  background:linear-gradient(180deg,#ffffff,#e6efff) !important;
  border-color:rgba(52,96,164,0.52) !important;
  box-shadow:0 1px 0 rgba(255,255,255,0.98) inset, 0 12px 24px rgba(22,51,90,0.16);
}
.__account_dialog .btn.btn-primary,
.__orders_dialog .btn.btn-primary,
.__delivery_dialog .btn.btn-primary{
  background:linear-gradient(90deg,var(--accent),var(--accent-2)) !important;
  color:#fff !important;
  border-color:rgba(196,92,24,0.28) !important;
  box-shadow:0 12px 28px rgba(242,107,56,0.32), 0 1px 0 rgba(255,255,255,0.28) inset !important;
}
.__account_dialog .btn.btn-primary:hover,
.__orders_dialog .btn.btn-primary:hover,
.__delivery_dialog .btn.btn-primary:hover{
  transform:translateY(-1px);
  filter:brightness(1.04) saturate(1.06);
  box-shadow:0 16px 30px rgba(242,107,56,0.38), 0 1px 0 rgba(255,255,255,0.32) inset !important;
}
.__account_addr_actions .btn{
  min-height:32px;
  padding:6px 10px;
  border-radius:10px;
  font-size:12px;
  font-weight:700;
}
.__account_header_actions .btn,
.__account_dialog .actions .btn,
.__account_form_actions .btn{
  min-height:40px;
  padding:10px 16px;
  border-radius:12px;
}
.__orders_dialog{
  width:900px;
  max-width:calc(100% - 36px);
  max-height:calc(100dvh - 56px);
  padding:16px;
  display:flex;
  flex-direction:column;
  overflow:hidden;
  box-shadow:0 12px 30px rgba(2,6,23,0.14);
  contain:layout paint style;
}
.__orders_dialog .dialog-body{
  display:flex;
  flex-direction:column;
  gap:10px;
  flex:1;
  min-height:0;
  max-height:none;
  overflow:hidden;
}
.__orders_hint{margin:0;color:var(--muted)}
.__orders_overlay{backdrop-filter:none !important;background:rgba(2,6,23,0.26) !important}
.__orders_toolbar{display:grid;grid-template-columns:minmax(0,1.6fr) repeat(2,minmax(0,1fr)) 170px auto;gap:8px;align-items:center}
.__orders_field{height:38px;border:1px solid rgba(10,34,64,0.14);border-radius:10px;padding:0 10px;font-size:13px;background:#fff;color:var(--deep)}
.__orders_search{min-width:0}
.__orders_clear{min-height:38px;padding:8px 12px}
.__orders_list{display:grid;gap:10px;flex:1;min-height:0;max-height:none;overflow:auto;padding-right:4px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;contain:content}
.__orders_loading,.__orders_empty{padding:14px;border-radius:12px;border:1px dashed rgba(10,34,64,0.18);background:#fcfdff;color:var(--muted);font-size:14px}
.__order_card{border:1px solid rgba(10,34,64,0.08);border-radius:12px;padding:12px;background:#fff;content-visibility:auto;contain-intrinsic-size:180px;contain:layout paint}
.__order_head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.__order_title{font-weight:900;color:var(--deep)}
.__order_date{font-size:12px;color:var(--muted)}
.__order_meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.__order_chip{font-size:12px;font-weight:700;color:#0b223f;background:#f4f7fb;border:1px solid rgba(10,34,64,0.1);padding:4px 8px;border-radius:999px}
.__order_chip.__order_total{background:#fff7ed;border-color:rgba(242,107,56,0.32);color:#b45309}
.__order_address{font-size:13px;color:rgba(6,26,43,0.8);margin-bottom:8px}
.__order_items{margin:0;padding-left:18px;display:grid;gap:4px}
.__order_items li{font-size:13px;color:rgba(6,26,43,0.86)}
.__orders_qty{display:inline-block;min-width:26px;font-weight:800;color:#0b223f}
.__orders_more{color:var(--muted);font-style:italic}
.__order_actions{display:flex;justify-content:flex-end;margin-top:8px}
.__order_repeat_btn{min-width:150px}
.__orders_pager{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding-top:10px;margin-top:8px;border-top:1px solid rgba(10,34,64,0.08)}
.__orders_pager[hidden]{display:none !important}
.__orders_progress{font-size:12px;color:var(--muted);font-weight:700;text-align:center}
.__orders_more_btn{min-width:210px;align-self:center}
.__checkout_confirm{display:grid;gap:10px}
.__checkout_meta{display:grid;gap:6px;padding:10px;border:1px solid rgba(10,34,64,0.08);border-radius:10px;background:#fff}
.__checkout_items{margin:0;padding:0;list-style:none;display:grid;gap:0;max-height:34vh;overflow:auto;border:1px solid rgba(10,34,64,0.08);border-radius:10px;background:#fff}
.__checkout_item{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:9px 10px;border-bottom:1px solid rgba(10,34,64,0.07);font-size:13px;color:var(--deep)}
.__checkout_item:last-child{border-bottom:0}
.__checkout_item span{display:grid;gap:2px}
.__checkout_item small{color:var(--muted)}
.__checkout_item_empty{color:var(--muted)}
.__checkout_more{font-size:12px;color:var(--muted);font-style:italic}
.__checkout_total{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;background:#fff7ed;border:1px solid rgba(242,107,56,0.25);font-weight:800;color:#b45309}
.__checkout_total span{font-size:16px}
.__checkout_help{border:1px solid rgba(14,94,184,0.2);background:linear-gradient(180deg,#f8fbff,#eef5ff);border-radius:10px;padding:10px}
.__checkout_help_title{font-weight:900;color:#0b223f}
.__checkout_help_text{margin-top:2px;font-size:12px;color:#34506f}
.__checkout_help_actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.__checkout_help_link{display:inline-flex;align-items:center;justify-content:center;text-decoration:none !important;min-width:118px}
@media(max-width:880px){
  .__account_layout{grid-template-columns:1fr}
  .__account_dialog{width:calc(100% - 16px)}
  .__orders_dialog{width:calc(100% - 16px);max-height:calc(100dvh - 20px)}
  .__orders_toolbar{grid-template-columns:1fr 1fr}
  .__orders_search{grid-column:1 / -1}
  .__orders_clear{grid-column:1 / -1}
  .__orders_pager{align-items:center}
  .__orders_more_btn{width:auto;min-width:180px}
  .__checkout_help_actions{display:grid;grid-template-columns:1fr;gap:8px}
  .__checkout_help_link{width:100%}
  .__addr_search_head h3{font-size:26px}
  .__addr_search_box{grid-template-columns:1fr}
  .__addr_search_geo{width:100%}
  .__addr_map_dialog{width:calc(100% - 14px)}
  .__addr_map_canvas{height:320px}
}
@media(max-width:640px){
  .__dialog{width:calc(100% - 32px)}
  .__addr_search_head h3{font-size:23px}
  .__addr_map_head{flex-direction:column;align-items:stretch}
  .__addr_map_head .btn{width:100%}
  .__addr_map_canvas{height:280px}
}
`;
  document.head.appendChild(s);
}

function getTopDialogOverlay(){
  try{
    const overlays = Array.from(document.querySelectorAll('.__dialog_overlay')).filter((el) => !!el && el.isConnected);
    if (!overlays.length) return null;
    overlays.sort((a, b) => {
      try{
        const za = Number((window.getComputedStyle(a).zIndex || '').replace(/[^\d-]/g, '')) || 0;
        const zb = Number((window.getComputedStyle(b).zIndex || '').replace(/[^\d-]/g, '')) || 0;
        if (za !== zb) return za - zb;
      }catch(_){ }
      if (a === b) return 0;
      const rel = a.compareDocumentPosition(b);
      return (rel & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });
    return overlays[overlays.length - 1] || null;
  }catch(_){
    return null;
  }
}

function isTopDialogOverlay(overlay){
  if (!overlay) return false;
  const top = getTopDialogOverlay();
  return top === overlay;
}

function showAddressDetailsModal(initial = {}, { title = 'Nombre e instrucciones' } = {}){
  return new Promise((resolve) => {
    try{
      ensureGlobalDialogStyles();
      const startLabel = sanitizeAddressAlias(initial && (initial.label || initial.alias) ? (initial.label || initial.alias) : '');
      const startNotes = sanitizeDeliveryNotes(initial && (initial.notes || initial.instrucciones || initial.instructions || initial.delivery_notes) ? (initial.notes || initial.instrucciones || initial.instructions || initial.delivery_notes) : '');
      const overlay = document.createElement('div');
      overlay.className = '__dialog_overlay';
      overlay.style.zIndex = '5420';
      overlay.innerHTML = `
        <div class="__dialog __dialog--info" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="dialog-header"><span class="dialog-icon">✍️</span><h3>${escapeHtml(title)}</h3></div>
          <div class="dialog-body">
            <label class="__delivery_alias_label" for="__addr_meta_alias">Nombre de la dirección (opcional)</label>
            <input id="__addr_meta_alias" class="__delivery_alias_input" type="text" placeholder="Ej: Casa, Trabajo" value="${escapeHtml(startLabel)}" />
            <label class="__addr_notes_label" for="__addr_meta_notes" style="margin-top:10px">Instrucciones (opcional)</label>
            <textarea id="__addr_meta_notes" placeholder="Ej: portón negro, timbre 2, dejar en recepción">${escapeHtml(startNotes)}</textarea>
          </div>
          <div class="actions">
            <button class="btn btn-ghost" data-action="cancel">Cancelar</button>
            <button class="btn btn-primary" data-action="save">Guardar</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const dialog = overlay.querySelector('.__dialog');
      const aliasEl = overlay.querySelector('#__addr_meta_alias');
      const notesEl = overlay.querySelector('#__addr_meta_notes');
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        try{ overlay.remove(); window.removeEventListener('keydown', onKey); }catch(_){ }
      };
      const closeWith = (value) => {
        cleanup();
        resolve(value || null);
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape' && isTopDialogOverlay(overlay)) closeWith(null);
      };
      window.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay && isTopDialogOverlay(overlay)) closeWith(null);
      });
      overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeWith(null));
      overlay.querySelector('[data-action="save"]')?.addEventListener('click', () => {
        const label = sanitizeAddressAlias(aliasEl && aliasEl.value ? aliasEl.value : '');
        const notes = sanitizeDeliveryNotes(notesEl && notesEl.value ? notesEl.value : '');
        closeWith({ label, notes });
      });
      requestAnimationFrame(() => {
        try{
          overlay.classList.add('open');
          if (dialog) dialog.classList.add('open');
        }catch(_){ }
      });
      setTimeout(() => {
        try{
          if (aliasEl){
            aliasEl.focus();
            aliasEl.select();
          }
        }catch(_){ }
      }, 30);
    }catch(e){
      console.error('showAddressDetailsModal failed', e);
      resolve(null);
    }
  });
}

function showDialog({title, message = '', html = '', buttons = [{ label: 'OK', value: true, primary: true }], dismissible = true, type = ''} = {}){
  return new Promise((resolve) => {
    try{
      ensureGlobalDialogStyles();

      // small map for emoji icons — keeps things fast and dependency-free
      const iconMap = { info: 'ℹ️', success: '✔️', warning: '⚠️', danger: '✖️' };
      const iconHtml = type ? ('<span class="dialog-icon">' + (iconMap[type] || '') + '</span>') : '';

      const overlay = document.createElement('div'); overlay.className = '__dialog_overlay'; overlay.id = '__dialog_overlay';
      overlay.style.zIndex = '5400';
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
      if (dismissible) overlay.addEventListener('click', (ev)=>{
        if (ev.target === overlay && isTopDialogOverlay(overlay)){
          cleanup();
          resolve(false);
        }
      });
      const onKey = (ev)=>{
        if (ev.key === 'Escape' && isTopDialogOverlay(overlay)){
          cleanup();
          resolve(false);
        }
      };
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
let __mpHealthCache = null;
let __mpHealthCacheTs = 0;
async function getMercadoPagoHealth(force = false){
  try{
    if (!force && __mpHealthCache && (Date.now() - __mpHealthCacheTs) < 60000) return __mpHealthCache;
  }catch(_){ }

  const tryUrls = [];
  try{
    const pageOrigin = (location && location.protocol && location.protocol.startsWith('http') && location.origin) ? location.origin : null;
    if (typeof API_ORIGIN === 'string' && API_ORIGIN) {
      if (pageOrigin && pageOrigin !== API_ORIGIN) {
        tryUrls.push(API_ORIGIN + '/payments/mercadopago/health');
        tryUrls.push(pageOrigin + '/payments/mercadopago/health');
      } else {
        tryUrls.push((pageOrigin || API_ORIGIN) + '/payments/mercadopago/health');
      }
    } else if (pageOrigin) {
      tryUrls.push(pageOrigin + '/payments/mercadopago/health');
    }
  }catch(_){ }
  tryUrls.push('/payments/mercadopago/health');

  const seen = new Set();
  const ordered = tryUrls.filter(u => { if(!u || seen.has(u)) return false; seen.add(u); return true; });
  for (const url of ordered){
    try{
      const res = await fetchWithTimeout(url, { cache: 'no-store', mode: 'cors' }, 6000);
      if (!res || !res.ok) continue;
      const data = await res.json().catch(() => null);
      if (data && typeof data === 'object'){
        __mpHealthCache = data;
        __mpHealthCacheTs = Date.now();
        return data;
      }
    }catch(_){ }
  }
  return null;
}

async function showPaymentMethodModal(){
  let mpEnabled = true;
  let mpDesc = 'Pagar online con checkout';
  try{
    const health = await getMercadoPagoHealth();
    if (health && health.configured === false){
      mpEnabled = false;
      mpDesc = 'No disponible en este momento';
    }
  }catch(_){ }
  return new Promise((resolve) => {
    try{
      if (!document.getElementById('__payment_method_styles')){
        const s = document.createElement('style');
        s.id = '__payment_method_styles';
        s.textContent = `
.__pay_overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(2,6,23,0.42);backdrop-filter:blur(3px);z-index:5200;overflow:auto;-webkit-overflow-scrolling:touch}
.__pay_dialog{width:560px;max-width:calc(100% - 4px);max-height:calc(100dvh - 28px);overflow:auto;background:linear-gradient(180deg, rgba(255,255,255,0.98), var(--surface));border-radius:14px;padding:16px;border:1px solid rgba(10,34,64,0.08);box-shadow:0 18px 48px rgba(2,6,23,0.18)}
.__pay_title{margin:0;font-size:18px;color:var(--deep)}
.__pay_sub{margin:6px 0 14px 0;color:var(--muted);font-size:14px}
.__pay_cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.__pay_card{border:1px solid rgba(0,0,0,0.08);background:#fff;border-radius:12px;padding:14px;display:flex;align-items:center;gap:10px;cursor:pointer;text-align:left;min-height:78px}
.__pay_card:hover{border-color:rgba(242,107,56,0.35);box-shadow:0 8px 20px rgba(2,6,23,0.08)}
.__pay_card[disabled]{opacity:.55;cursor:not-allowed;box-shadow:none}
.__pay_logo{width:42px;height:42px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;color:#fff;flex-shrink:0}
.__pay_logo.mp{background:linear-gradient(135deg,#009ee3,#005ac2)}
.__pay_logo.cash{background:linear-gradient(135deg,#10b981,#0f766e)}
.__pay_name{font-weight:800;color:var(--deep)}
.__pay_desc{font-size:12px;color:var(--muted)}
.__pay_name, .__pay_desc{display:block}
.__pay_actions{display:flex;justify-content:flex-end;margin-top:12px}
.__pay_cancel{background:transparent;border:1px solid rgba(0,0,0,0.08);padding:8px 12px;border-radius:10px;color:var(--deep)}
@media(max-width:640px){
  .__pay_overlay{align-items:center;justify-content:center;padding:12px 10px}
  .__pay_dialog{width:min(460px,calc(100% - 4px));max-width:calc(100% - 4px);max-height:calc(100dvh - 24px)}
  .__pay_cards{grid-template-columns:1fr}
}
`;
        document.head.appendChild(s);
      }

      const overlay = document.createElement('div');
      overlay.className = '__pay_overlay';
      overlay.innerHTML = `
        <div class="__pay_dialog" role="dialog" aria-modal="true" aria-label="Método de pago">
          <h3 class="__pay_title">Selecciona método de pago</h3>
          <p class="__pay_sub">Elige cómo quieres pagar tu pedido.</p>
          <div class="__pay_cards">
            <button type="button" class="__pay_card" data-method="mercadopago" ${mpEnabled ? '' : 'disabled aria-disabled="true"'}>
              <span class="__pay_logo mp">MP</span>
              <span>
                <span class="__pay_name">Mercado Pago</span>
                <span class="__pay_desc">${escapeHtml(mpDesc)}</span>
              </span>
            </button>
            <button type="button" class="__pay_card" data-method="cash">
              <span class="__pay_logo cash">$</span>
              <span>
                <span class="__pay_name">Efectivo</span>
                <span class="__pay_desc">Pagas al recibir el pedido</span>
              </span>
            </button>
          </div>
          <div class="__pay_actions">
            <button type="button" class="__pay_cancel" data-action="cancel">Cancelar</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const cleanup = () => {
        try{ overlay.remove(); window.removeEventListener('keydown', onKey); }catch(_){ }
      };
      const closeWith = (value) => { cleanup(); resolve(value); };
      const onKey = (ev) => { if (ev.key === 'Escape') closeWith(null); };
      window.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (ev) => {
        if (!ev.target.closest('.__pay_dialog')) closeWith(null);
      });

      overlay.querySelectorAll('[data-method]').forEach(btn => {
        btn.addEventListener('click', () => closeWith(btn.getAttribute('data-method')));
      });
      const cancel = overlay.querySelector('[data-action="cancel"]');
      if (cancel) cancel.addEventListener('click', () => closeWith(null));
      const firstCard = overlay.querySelector('[data-method]');
      if (firstCard) firstCard.focus();
    }catch(e){
      console.error('showPaymentMethodModal failed', e);
      resolve(null);
    }
  });
}
function showJsonModal(obj, title = 'Detalle'){
  const html = `<pre style="white-space:pre-wrap;max-height:48vh;overflow:auto">${escapeHtml(JSON.stringify(obj, null, 2))}</pre>`;
  return showDialog({ title, html, buttons: [{ label: 'Cerrar', value: true, primary: true }], type: 'info' });
}
function getCurrentAccountStorageId(){
  try{
    const email = getTokenEmail();
    if (email) return 'user:' + String(email).trim().toLowerCase();
  }catch(_){ }
  return 'guest';
}
function getAddressBookStorageKey(accountId = null){
  const who = String(accountId || getCurrentAccountStorageId() || 'guest').trim().toLowerCase();
  return ADDRESS_BOOK_STORAGE_PREFIX + who;
}
function getLastUsedAddressStorageKey(accountId = null){
  const who = String(accountId || getCurrentAccountStorageId() || 'guest').trim().toLowerCase();
  return LAST_USED_ADDRESS_STORAGE_PREFIX + who;
}
function setLastUsedAddressId(addressId, accountId = null){
  try{
    const key = getLastUsedAddressStorageKey(accountId);
    const id = String(addressId || '').trim();
    if (!id) { localStorage.removeItem(key); return; }
    localStorage.setItem(key, id);
  }catch(_){ }
}
function getLastUsedAddressId(accountId = null){
  try{
    const raw = localStorage.getItem(getLastUsedAddressStorageKey(accountId));
    const id = String(raw || '').trim();
    return id || null;
  }catch(_){ return null; }
}
function sanitizeAddressAlias(value){
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 36);
}
function sanitizeAddressText(value, maxLen = 80){
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function sanitizeAddressLongText(value, maxLen = 200){
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function sanitizeAddressNumber(value){
  return String(value || '').replace(/\s+/g, '').trim().slice(0, 12);
}
function normalizeAddressSearchFreeText(value){
  try{
    return String(value || '')
      .replace(/[;|]+/g, ' ')
      .replace(/\bprovincia\s+de\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }catch(_){ return String(value || '').trim(); }
}
function stripAddressContextTokens(value){
  try{
    return normalizeRegionToken(value || '')
      .replace(/\b(?:provincia|departamento|distrito|de|del|la|las|el|los)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }catch(_){ return normalizeRegionToken(value || ''); }
}
function toAddressTitleCase(value){
  return String(value || '')
    .split(/\s+/)
    .map((token) => {
      const raw = String(token || '').trim();
      if (!raw) return '';
      if (!/[A-Za-z\u00c0-\u024f]/.test(raw)) return raw;
      const lower = raw.toLocaleLowerCase('es-AR');
      return lower.charAt(0).toLocaleUpperCase('es-AR') + lower.slice(1);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function sanitizeDeliveryNotes(value){
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 240);
}
function addressAliasExists(label, addresses = [], excludeId = null){
  const alias = sanitizeAddressAlias(label).toLowerCase();
  if (!alias) return false;
  const exclude = String(excludeId || '').trim();
  return (Array.isArray(addresses) ? addresses : []).some((addr) => {
    if (!addr) return false;
    if (exclude && String(addr.id || '').trim() === exclude) return false;
    return sanitizeAddressAlias(addr.label || '').toLowerCase() === alias;
  });
}
function buildUniqueAddressAlias(addresses = [], excludeId = null){
  const base = 'Dirección';
  if (!addressAliasExists(base, addresses, excludeId)) return base;
  for (let i = 2; i <= 500; i++){
    const candidate = base + ' ' + i;
    if (!addressAliasExists(candidate, addresses, excludeId)) return candidate;
  }
  return base + ' ' + String(Date.now()).slice(-4);
}
function validateAddressInput(
  data,
  {
    addresses = [],
    excludeId = null,
    requireAlias = false,
    enforceUniqueAlias = false,
    autoAliasWhenEmpty = false
  } = {}
){
  const value = {
    label: sanitizeAddressAlias(data?.label || data?.alias || ''),
    barrio: sanitizeAddressText(data?.barrio || ''),
    calle: sanitizeAddressText(data?.calle || ''),
    numeracion: sanitizeAddressNumber(data?.numeracion || data?.numero || '')
  };
  if (!value.barrio || !value.calle || !value.numeracion){
    return { ok: false, field: !value.barrio ? 'barrio' : (!value.calle ? 'calle' : 'numeracion'), message: 'Completa barrio, calle y numeración.' };
  }
  const textPattern = /^[0-9A-Za-z\u00c0-\u00ff .,'-]{2,80}$/;
  if (!textPattern.test(value.barrio) || !/[A-Za-z\u00c0-\u00ff]/.test(value.barrio)){
    return { ok: false, field: 'barrio', message: 'El barrio debe tener al menos 2 caracteres válidos.' };
  }
  if (!textPattern.test(value.calle) || !/[A-Za-z\u00c0-\u00ff]/.test(value.calle)){
    return { ok: false, field: 'calle', message: 'La calle debe tener al menos 2 caracteres válidos.' };
  }
  if (!/^(?:[0-9]{1,6}[A-Za-z]?|s\/?n)$/i.test(value.numeracion)){
    return { ok: false, field: 'numeracion', message: 'La numeración debe ser válida (ejemplo: 569 o S/N).' };
  }
  if (value.label){
    if (value.label.length < 2){
      return { ok: false, field: 'alias', message: 'El alias debe tener al menos 2 caracteres.' };
    }
    if (!/^[0-9A-Za-z\u00c0-\u00ff _.'-]{2,36}$/.test(value.label)){
      return { ok: false, field: 'alias', message: 'El alias contiene caracteres inválidos.' };
    }
  }
  if (!value.label && requireAlias){
    return { ok: false, field: 'alias', message: 'Define un alias para esta dirección.' };
  }
  if (enforceUniqueAlias){
    if (!value.label && autoAliasWhenEmpty){
      value.label = buildUniqueAddressAlias(addresses, excludeId);
    }
    if (value.label && addressAliasExists(value.label, addresses, excludeId)){
      return { ok: false, field: 'alias', message: 'Ya existe una dirección con ese alias. Usa otro nombre.' };
    }
  }
  return { ok: true, value };
}

function parseStreetAndNumber(value){
  const raw = normalizeAddressSearchFreeText(sanitizeAddressLongText(value || '', 120));
  if (!raw) return { calle: '', numeracion: '' };
  const match = raw.match(/^(.+?)\s+([0-9]{1,6}[A-Za-z]?|s\/?n)$/i);
  if (match){
    return {
      calle: sanitizeAddressText(match[1] || '', 80),
      numeracion: sanitizeAddressNumber(match[2] || '')
    };
  }
  // Allows queries like "Almirante Brown 1735 de Las Heras".
  const inlineMatch = raw.match(/^(.+?)\s+([0-9]{1,6}[A-Za-z]?)\b(?:[\s,.-]+.*)?$/i);
  if (inlineMatch){
    return {
      calle: sanitizeAddressText(inlineMatch[1] || '', 80),
      numeracion: sanitizeAddressNumber(inlineMatch[2] || '')
    };
  }
  // Allows inputs that start with number: "1735 Almirante Brown".
  const invertedMatch = raw.match(/^([0-9]{1,6}[A-Za-z]?)\s+(.+)$/i);
  if (invertedMatch){
    return {
      calle: sanitizeAddressText(invertedMatch[2] || '', 80),
      numeracion: sanitizeAddressNumber(invertedMatch[1] || '')
    };
  }
  return { calle: sanitizeAddressText(raw, 80), numeracion: '' };
}

function extractAddressPartsFromDisplay(displayName){
  const raw = sanitizeAddressLongText(displayName || '', 220);
  if (!raw) return { barrio: '', calle: '', numeracion: '' };
  const pieces = raw.split(',').map(p => sanitizeAddressText(p, 80)).filter(Boolean);
  const streetInfo = parseStreetAndNumber(pieces[0] || '');
  const barrio = sanitizeAddressText(pieces[1] || pieces[2] || '', 80);
  return { barrio, calle: streetInfo.calle, numeracion: streetInfo.numeracion };
}

function normalizeRegionToken(value){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegexToken(value){
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasNormalizedWordToken(text, token){
  try{
    const haystack = normalizeRegionToken(text || '');
    const needle = normalizeRegionToken(token || '');
    if (!haystack || !needle) return false;
    return new RegExp(`(^|\\s)${escapeRegexToken(needle)}(\\s|$)`, 'i').test(haystack);
  }catch(_){ return false; }
}

function isKnownMendozaPostalDigits(value){
  try{
    const digits = String(value || '').trim();
    if (!/^\d{4}$/.test(digits)) return false;
    return Object.prototype.hasOwnProperty.call(MENDOZA_POSTAL_TO_DEPARTMENTS, digits);
  }catch(_){ return false; }
}

function hasPostalContextHint(value){
  try{
    const token = normalizeRegionToken(value || '').replace(/\./g, ' ');
    if (!token) return false;
    if (/\b(?:cp|codigo postal|cod postal|postal)\b/.test(token)) return true;
    if (/(?:^|,)\s*\d{4}\b/.test(String(value || ''))) return true;
    if (/\bargentina\b/.test(token) && /\bmendoza\b/.test(token)) return true;
    return false;
  }catch(_){ return false; }
}

function extractNormalizedPostalToken(value){
  try{
    const raw = String(value || '').trim();
    if (!raw) return '';
    const explicitMatch = raw.match(/\bM\s*(\d{4})\b/i);
    if (explicitMatch && explicitMatch[1]) return String(explicitMatch[1]);

    const bareMatches = Array.from(raw.matchAll(/\b(\d{4})\b/g)).map((m) => String(m && m[1] || '').trim()).filter(Boolean);
    if (!bareMatches.length) return '';
    const knownMatch = bareMatches.find((digits) => isKnownMendozaPostalDigits(digits)) || '';
    if (!knownMatch) return '';
    if (hasPostalContextHint(raw)) return knownMatch;

    const regionProbe = normalizeRegionToken(raw);
    const hasDepartmentHint = MENDOZA_DEPARTMENTS.some((dep) => {
      const depToken = normalizeRegionToken(dep);
      return depToken && regionProbe.includes(depToken);
    });
    if (hasDepartmentHint) return knownMatch;
    if (bareMatches.length >= 2) return knownMatch;
    return '';
  }catch(_){ return ''; }
}

function normalizePostalCodeToken(value){
  try{
    const digits = extractNormalizedPostalToken(value);
    return digits ? ('M' + digits) : '';
  }catch(_){ return ''; }
}

function getDepartmentsForPostalToken(value){
  try{
    const digits = extractNormalizedPostalToken(value);
    if (!digits) return [];
    const departments = MENDOZA_POSTAL_TO_DEPARTMENTS[digits];
    return Array.isArray(departments) ? departments.slice() : [];
  }catch(_){ return []; }
}

function inferDepartmentFromPostalAndHints(postalCode, hints = []){
  try{
    const departments = getDepartmentsForPostalToken(postalCode);
    if (!departments.length) return '';
    const probe = normalizeRegionToken((Array.isArray(hints) ? hints : []).filter(Boolean).join(' '));
    if (!probe) return String(departments[0] || '');
    for (const dep of departments){
      const token = normalizeRegionToken(dep);
      if (token && probe.includes(token)) return String(dep || '');
    }
    return String(departments[0] || '');
  }catch(_){ return ''; }
}

function extractDepartmentsFromQueryText(value){
  try{
    const token = normalizeRegionToken(value || '');
    if (!token) return [];
    const out = [];
    for (const dep of MENDOZA_DEPARTMENTS){
      const depToken = normalizeRegionToken(dep);
      if (!depToken) continue;
      if (token.includes(depToken)) out.push(dep);
    }
    return out;
  }catch(_){ return []; }
}

function normalizeDepartmentToken(value){
  return normalizeRegionToken(String(value || '').replace(/\./g, ' '));
}

function findDepartmentInHints(hints = []){
  try{
    const probe = normalizeRegionToken((Array.isArray(hints) ? hints : [hints]).filter(Boolean).join(' '));
    if (!probe) return '';
    for (const dep of MENDOZA_DEPARTMENTS){
      const token = normalizeDepartmentToken(dep);
      if (!token) continue;
      if (probe.includes(token)) return String(dep || '');
    }
    return '';
  }catch(_){ return ''; }
}

function normalizeKnownMendozaDepartment(value){
  try{
    const token = normalizeDepartmentToken(value);
    if (!token) return '';
    for (const dep of MENDOZA_DEPARTMENTS){
      if (normalizeDepartmentToken(dep) === token) return String(dep || '');
    }
    return '';
  }catch(_){ return ''; }
}

function collectAddressSearchPreferredDepartments(query = ''){
  try{
    const out = [];
    const seen = new Set();
    const pushDepartment = (candidate = '', hints = []) => {
      const hintList = Array.isArray(hints) ? hints : [hints];
      const inferredDepartment = sanitizeAddressText(
        candidate ||
        findDepartmentInHints(hintList) ||
        inferDepartmentFromPostalAndHints(normalizePostalCodeToken(hintList.join(' ')), hintList) ||
        '',
        80
      );
      const canonicalDepartment = normalizeKnownMendozaDepartment(inferredDepartment);
      if (!canonicalDepartment) return;
      const canonicalToken = normalizeDepartmentToken(canonicalDepartment);
      if (!canonicalToken || seen.has(canonicalToken)) return;
      seen.add(canonicalToken);
      out.push(canonicalDepartment);
    };

    const cleanQuery = sanitizeAddressLongText(query || '', 120);
    extractDepartmentsFromQueryText(cleanQuery).forEach((dep) => pushDepartment(dep, [cleanQuery]));
    getDepartmentsForPostalToken(normalizePostalCodeToken(cleanQuery)).forEach((dep) => pushDepartment(dep, [cleanQuery]));

    const accountId = getCurrentAccountStorageId();
    const book = loadAddressBook(accountId);
    const addresses = Array.isArray(book && book.addresses) ? book.addresses : [];
    const lastUsedId = getLastUsedAddressId(accountId);
    const lastUsedAddress = addresses.find((addr) => String(addr && addr.id || '') === String(lastUsedId || '')) || null;
    const defaultAddress = addresses.find((addr) => String(addr && addr.id || '') === String(book && book.defaultId || '')) ||
      addresses[0] ||
      null;
    const deliveryCache = loadDeliveryAddressCache();
    const prefillCache = loadLocationPrefillCache();
    [deliveryCache, prefillCache, lastUsedAddress, defaultAddress].forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const hints = [
        entry.department,
        entry.barrio,
        entry.query_hint,
        entry.full_text,
        entry.label
      ].filter(Boolean);
      pushDepartment(entry.department || '', hints);
      const cachedPostal = normalizePostalCodeToken(
        entry.postal_code ||
        entry.query_hint ||
        entry.full_text ||
        entry.label ||
        ''
      );
      getDepartmentsForPostalToken(cachedPostal).forEach((dep) => pushDepartment(dep, hints));
    });

    return out.slice(0, 3);
  }catch(_){ return []; }
}

function suggestionMatchesDepartmentToken(suggestion, department){
  try{
    const depToken = normalizeDepartmentToken(department);
    if (!depToken || !suggestion || typeof suggestion !== 'object') return false;
    const suggestionDepartment = normalizeDepartmentToken(
      suggestion.department ||
      findDepartmentInHints([suggestion.full_text, suggestion.label, suggestion.barrio, suggestion.query_hint]) ||
      ''
    );
    if (suggestionDepartment && suggestionDepartment === depToken) return true;
    const probe = normalizeRegionToken([
      suggestion.full_text,
      suggestion.label,
      suggestion.barrio,
      suggestion.department
    ].filter(Boolean).join(' '));
    return !!probe && probe.includes(depToken);
  }catch(_){ return false; }
}

function suggestionMatchesStreetToken(suggestion, streetToken){
  try{
    const queryStreetToken = normalizeRegionToken(streetToken || '');
    if (!queryStreetToken) return false;
    const suggestionStreetToken = normalizeRegionToken(
      suggestion?.calle ||
      parseStreetAndNumber(suggestion?.full_text || suggestion?.label || '').calle ||
      ''
    );
    if (!suggestionStreetToken) return false;
    return suggestionStreetToken.includes(queryStreetToken) || queryStreetToken.includes(suggestionStreetToken);
  }catch(_){ return false; }
}

function normalizeArcGisAddrType(value){
  return normalizeRegionToken(String(value || '').replace(/[^a-z0-9 ]/ig, ' '));
}

function isArcGisPointAddressType(value){
  try{
    const token = normalizeArcGisAddrType(value);
    if (!token) return false;
    return token.includes('pointaddress') || token.includes('streetaddress');
  }catch(_){ return false; }
}

function haversineDistanceKm(lat1, lon1, lat2, lon2){
  try{
    const toRad = (deg) => Number(deg) * Math.PI / 180;
    const aLat = Number(lat1);
    const aLon = Number(lon1);
    const bLat = Number(lat2);
    const bLon = Number(lon2);
    if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const rLat1 = toRad(aLat);
    const rLat2 = toRad(bLat);
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return 6371 * c;
  }catch(_){ return Number.POSITIVE_INFINITY; }
}

function postalMatchesDepartment(postalCode, department){
  try{
    const postal = normalizePostalCodeToken(postalCode);
    const depToken = normalizeDepartmentToken(department);
    if (!postal || !depToken) return true;
    const deps = getDepartmentsForPostalToken(postal);
    if (!deps.length) return true;
    return deps.some((dep) => normalizeDepartmentToken(dep) === depToken);
  }catch(_){ return true; }
}

function selectPostalForDepartment(postalCode, department, hints = []){
  try{
    const desiredDepartment = sanitizeAddressText(
      department ||
      findDepartmentInHints(hints) ||
      '',
      80
    );
    const direct = normalizePostalCodeToken(postalCode || '');
    if (direct && postalMatchesDepartment(direct, desiredDepartment)) return direct;
    const candidates = Array.isArray(hints) ? hints : [hints];
    for (const source of candidates){
      const candidate = normalizePostalCodeToken(source || '');
      if (!candidate) continue;
      if (postalMatchesDepartment(candidate, desiredDepartment)) return candidate;
    }
    return direct && !desiredDepartment ? direct : '';
  }catch(_){ return normalizePostalCodeToken(postalCode || ''); }
}

function expandAddressAbbreviationsForSearch(value){
  try{
    let v = sanitizeAddressLongText(value || '', 120);
    if (!v) return '';
    v = v
      .replace(/\bgral\.?\b/gi, 'General')
      .replace(/\bav\.?\b/gi, 'Avenida')
      .replace(/\bpje\.?\b/gi, 'Pasaje')
      .replace(/\bpto\.?\b/gi, 'Punto');
    return v.replace(/\s+/g, ' ').trim();
  }catch(_){ return sanitizeAddressLongText(value || '', 120); }
}

function isLikelyLasHerasPostal(postal){
  const departments = getDepartmentsForPostalToken(postal);
  return departments.some((dep) => normalizeRegionToken(dep) === 'las heras');
}

function isMendozaText(value){
  const token = normalizeRegionToken(value);
  if (!token) return false;
  return token.includes(ALLOWED_ADDRESS_REGION);
}

function hasNonMendozaRegionToken(value){
  const token = normalizeRegionToken(value);
  if (!token) return false;
  return NON_MENDOZA_REGION_TOKENS.some((probe) => token.includes(probe));
}

function isMendozaSuggestion(item, normalized = null){
  try{
    const raw = item && typeof item === 'object' ? item : {};
    const latRaw = Number(raw.lat);
    const lonRaw = Number(raw.lon);
    const latNorm = Number(normalized && normalized.lat);
    const lonNorm = Number(normalized && normalized.lon);
    const lat = Number.isFinite(latRaw) ? latRaw : (Number.isFinite(latNorm) ? latNorm : null);
    const lon = Number.isFinite(lonRaw) ? lonRaw : (Number.isFinite(lonNorm) ? lonNorm : null);
    const addr = (raw.address && typeof raw.address === 'object') ? raw.address : {};
    const probe = [
      raw.display_name,
      raw.full_text,
      raw.label,
      addr.state,
      addr.province,
      addr.region,
      addr.county,
      addr.state_district,
      addr.city,
      addr.town,
      normalized?.full_text,
      normalized?.label,
      normalized?.barrio
    ];
    const joined = normalizeRegionToken(probe.filter(Boolean).join(' '));
    if (joined && hasNonMendozaRegionToken(joined)) return false;
    if (probe.some(isMendozaText)) return true;
    if (lat !== null && lon !== null){
      return lat >= MENDOZA_BOUNDS.minLat &&
        lat <= MENDOZA_BOUNDS.maxLat &&
        lon >= MENDOZA_BOUNDS.minLon &&
        lon <= MENDOZA_BOUNDS.maxLon;
    }
    return false;
  }catch(_){ return false; }
}

function isMendozaPrefill(prefill){
  try{
    const p = prefill || {};
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    const probe = [
      p.full_text,
      p.label,
      p.barrio,
      p.calle
    ];
    const joined = normalizeRegionToken(probe.filter(Boolean).join(' '));
    if (joined && hasNonMendozaRegionToken(joined)) return false;
    if (probe.some(isMendozaText)) return true;
    if (Number.isFinite(lat) && Number.isFinite(lon)){
      return lat >= MENDOZA_BOUNDS.minLat &&
        lat <= MENDOZA_BOUNDS.maxLat &&
        lon >= MENDOZA_BOUNDS.minLon &&
        lon <= MENDOZA_BOUNDS.maxLon;
    }
    if (!joined) return true;
    // Compatibilidad con direcciones legacy guardadas sin provincia explícita.
    return true;
  }catch(_){ return false; }
}

function normalizeAddressEntry(entry){
  if (!entry || typeof entry !== 'object') return null;
  const displayParts = extractAddressPartsFromDisplay(entry.full_text || entry.full || entry.display_name || '');
  const barrio = sanitizeAddressText(entry.barrio || displayParts.barrio || '', 80);
  const calle = sanitizeAddressText(entry.calle || displayParts.calle || '', 80);
  const numeracion = sanitizeAddressNumber(entry.numeracion || entry.numero || displayParts.numeracion || '');
  const rawPostalCode = normalizePostalCodeToken(
    entry.postal_code ||
    entry.postcode ||
    entry.zip_code ||
    entry.zip ||
    entry.query_hint ||
    entry.query ||
    entry.full_text ||
    ''
  );
  const department = sanitizeAddressText(
    entry.department ||
    findDepartmentInHints([
      entry.department,
      entry.query_hint,
      entry.query,
      entry.full_text,
      entry.label,
      entry.barrio
    ]) ||
    inferDepartmentFromPostalAndHints(rawPostalCode, [
      entry.department,
      entry.barrio,
      entry.full_text,
      entry.label
    ]) ||
    '',
    80
  );
  const postalCode = selectPostalForDepartment(rawPostalCode, department, [
    entry.query_hint,
    entry.query,
    entry.full_text,
    entry.label,
    entry.barrio
  ]);
  if (!barrio || !calle || !numeracion) return null;
  const labelRaw = String(entry.label || entry.alias || '').trim();
  const hasNotesField = Object.prototype.hasOwnProperty.call(entry, 'notes') ||
    Object.prototype.hasOwnProperty.call(entry, 'instrucciones') ||
    Object.prototype.hasOwnProperty.call(entry, 'instructions') ||
    Object.prototype.hasOwnProperty.call(entry, 'delivery_notes');
  const notesValue = hasNotesField
    ? sanitizeDeliveryNotes(entry.notes || entry.instrucciones || entry.instructions || entry.delivery_notes || '')
    : null;
  const fullText = sanitizeAddressLongText(entry.full_text || entry.full || entry.display_name || '', 200);
  const latNum = Number(entry.lat);
  const lonNum = Number(entry.lon);
  const normalized = {
    id: String(entry.id || ('addr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
    label: labelRaw,
    barrio,
    calle,
    numeracion,
    postal_code: postalCode,
    department,
    query_hint: sanitizeAddressLongText(entry.query_hint || entry.query || entry.full_text || '', 120),
    full_text: fullText,
    lat: Number.isFinite(latNum) ? Number(latNum.toFixed(6)) : null,
    lon: Number.isFinite(lonNum) ? Number(lonNum.toFixed(6)) : null,
    created_at: Number(entry.created_at || Date.now())
  };
  if (hasNotesField) normalized.notes = notesValue;
  return normalized;
}
function buildAddressDisplay(addr){
  if (!addr) return '';
  const full = String(addr.full_text || '').trim();
  if (full) return full.split(',').slice(0, 3).join(',').trim() || full;
  const street = [String(addr.calle || '').trim(), String(addr.numeracion || '').trim()].filter(Boolean).join(' ');
  const barrio = String(addr.barrio || '').trim();
  const department = String(addr.department || '').trim();
  const postalCode = normalizePostalCodeToken(addr.postal_code || addr.postcode || '');
  const parts = [street, barrio, department, postalCode].filter(Boolean);
  return parts.join(', ');
}
function loadAddressBook(accountId = null){
  try{
    const raw = localStorage.getItem(getAddressBookStorageKey(accountId));
    if (!raw) return { defaultId: null, addresses: [] };
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.addresses) ? parsed.addresses : (Array.isArray(parsed) ? parsed : []);
    const normalized = [];
    for (const item of list){
      const n = normalizeAddressEntry(item);
      if (!n) continue;
      const dupe = normalized.find(x =>
        String(x.barrio).toLowerCase() === String(n.barrio).toLowerCase() &&
        String(x.calle).toLowerCase() === String(n.calle).toLowerCase() &&
        String(x.numeracion).toLowerCase() === String(n.numeracion).toLowerCase()
      );
      if (dupe){
        if (!dupe.label && n.label) dupe.label = n.label;
        if (!dupe.notes && n.notes) dupe.notes = n.notes;
        if (!dupe.query_hint && n.query_hint) dupe.query_hint = n.query_hint;
      } else {
        normalized.push(n);
      }
    }
    let defaultId = parsed && parsed.defaultId ? String(parsed.defaultId) : null;
    if (!defaultId && normalized.length) defaultId = normalized[0].id;
    if (defaultId && !normalized.find(a => a.id === defaultId)) defaultId = normalized.length ? normalized[0].id : null;
    return { defaultId, addresses: normalized };
  }catch(_){ return { defaultId: null, addresses: [] }; }
}
function saveAddressBook(book, accountId = null){
  try{
    const addresses = Array.isArray(book?.addresses) ? book.addresses.map(normalizeAddressEntry).filter(Boolean) : [];
    let defaultId = book && book.defaultId ? String(book.defaultId) : null;
    if (!defaultId && addresses.length) defaultId = addresses[0].id;
    if (defaultId && !addresses.find(a => a.id === defaultId)) defaultId = addresses.length ? addresses[0].id : null;
    localStorage.setItem(getAddressBookStorageKey(accountId), JSON.stringify({ defaultId, addresses }));
  }catch(_){ }
}
function upsertAddressInBook(entry, { accountId = null, setDefault = false } = {}){
  const normalized = normalizeAddressEntry(entry);
  if (!normalized) return null;
  const book = loadAddressBook(accountId);
  const byId = book.addresses.find(a => a.id === normalized.id);
  const byContent = !byId ? book.addresses.find(a =>
    String(a.barrio).toLowerCase() === String(normalized.barrio).toLowerCase() &&
    String(a.calle).toLowerCase() === String(normalized.calle).toLowerCase() &&
    String(a.numeracion).toLowerCase() === String(normalized.numeracion).toLowerCase()
  ) : null;
  const target = byId || byContent;
  if (target){
    target.barrio = normalized.barrio;
    target.calle = normalized.calle;
    target.numeracion = normalized.numeracion;
    target.postal_code = normalized.postal_code || target.postal_code || '';
    target.department = normalized.department || target.department || '';
    target.query_hint = normalized.query_hint || target.query_hint || '';
    if (normalized.full_text) target.full_text = normalized.full_text;
    if (normalized.lat != null) target.lat = normalized.lat;
    if (normalized.lon != null) target.lon = normalized.lon;
    if (Object.prototype.hasOwnProperty.call(normalized, 'notes')) target.notes = normalized.notes;
    if (normalized.label && (byId || !target.label)) target.label = normalized.label;
    if (!target.label) target.label = buildUniqueAddressAlias(book.addresses, target.id);
    if (!target.created_at) target.created_at = Date.now();
    if (setDefault || !book.defaultId) book.defaultId = target.id;
    saveAddressBook(book, accountId);
    return target;
  }
  if (!normalized.label) normalized.label = buildUniqueAddressAlias(book.addresses);
  if (!Object.prototype.hasOwnProperty.call(normalized, 'notes')) normalized.notes = '';
  book.addresses.unshift(normalized);
  if (setDefault || !book.defaultId) book.defaultId = normalized.id;
  saveAddressBook(book, accountId);
  return normalized;
}
function removeAddressFromBook(addressId, accountId = null){
  const id = String(addressId || '');
  if (!id) return;
  const book = loadAddressBook(accountId);
  book.addresses = book.addresses.filter(a => String(a.id) !== id);
  if (book.defaultId === id) book.defaultId = book.addresses.length ? book.addresses[0].id : null;
  saveAddressBook(book, accountId);
  if (getLastUsedAddressId(accountId) === id){
    setLastUsedAddressId(book.addresses.length ? book.addresses[0].id : null, accountId);
  }
}
function setDefaultAddressInBook(addressId, accountId = null){
  const id = String(addressId || '');
  if (!id) return;
  const book = loadAddressBook(accountId);
  if (!book.addresses.find(a => String(a.id) === id)) return;
  book.defaultId = id;
  saveAddressBook(book, accountId);
}
function getDefaultAddressFromBook(accountId = null){
  const book = loadAddressBook(accountId);
  if (!book.addresses.length) return null;
  const selected = book.addresses.find(a => a.id === book.defaultId) || book.addresses[0];
  return selected || null;
}

function getSavedAddressSuggestionMatches(query, { limit = 4, accountId = null } = {}){
  try{
    const clean = normalizeRegionToken(query || '');
    if (!clean || clean.length < 2) return [];
    const tokens = clean.split(' ').filter((token) => token.length >= 2);
    const book = loadAddressBook(accountId);
    const list = Array.isArray(book && book.addresses) ? book.addresses : [];
    const out = [];
    const seen = new Set();
    for (const addr of list){
      if (!addr || !isMendozaPrefill(addr)) continue;
      const haystack = normalizeRegionToken([
        addr.label,
        buildAddressDisplay(addr),
        addr.full_text,
        addr.barrio,
        addr.calle,
        addr.numeracion
      ].filter(Boolean).join(' '));
      if (!haystack) continue;
      const matches = haystack.includes(clean) || tokens.every((token) => haystack.includes(token));
      if (!matches) continue;
      const normalized = normalizeLocationPrefill({
        lat: addr.lat,
        lon: addr.lon,
        barrio: addr.barrio,
        calle: addr.calle,
        numeracion: addr.numeracion,
        postal_code: addr.postal_code,
        department: addr.department,
        query_hint: addr.query_hint,
        label: addr.label || buildAddressDisplay(addr),
        full_text: addr.full_text || buildAddressDisplay(addr),
        source: 'saved',
        ts: Date.now()
      });
      const key = `${normalizeRegionToken(normalized.full_text || normalized.label || '')}|${Number(normalized.lat || 0).toFixed(6)}|${Number(normalized.lon || 0).toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
      if (out.length >= Math.max(1, Number(limit) || 4)) break;
    }
    return out;
  }catch(_){ return []; }
}

function loadDeliveryAddressCache(){
  try{
    const raw = localStorage.getItem(DELIVERY_ADDRESS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const latNum = Number(parsed.lat);
    const lonNum = Number(parsed.lon);
    return {
      barrio: String(parsed.barrio || '').trim(),
      calle: String(parsed.calle || '').trim(),
      numeracion: String(parsed.numeracion || parsed.numero || '').trim(),
      postal_code: normalizePostalCodeToken(parsed.postal_code || parsed.postcode || parsed.zip_code || parsed.zip || ''),
      department: sanitizeAddressText(parsed.department || '', 80),
      query_hint: sanitizeAddressLongText(parsed.query_hint || parsed.query || '', 120),
      label: sanitizeAddressAlias(parsed.label || parsed.alias || ''),
      full_text: sanitizeAddressLongText(parsed.full_text || parsed.full || '', 200),
      lat: Number.isFinite(latNum) ? Number(latNum.toFixed(6)) : null,
      lon: Number.isFinite(lonNum) ? Number(lonNum.toFixed(6)) : null,
      instrucciones: sanitizeDeliveryNotes(parsed.instrucciones || parsed.instructions || parsed.delivery_notes || '')
    };
  }catch(_){ return null; }
}
function saveDeliveryAddressCache(data){
  try{
    const latNum = Number(data?.lat);
    const lonNum = Number(data?.lon);
    const payload = {
      barrio: String(data?.barrio || '').trim(),
      calle: String(data?.calle || '').trim(),
      numeracion: String(data?.numeracion || data?.numero || '').trim(),
      postal_code: normalizePostalCodeToken(data?.postal_code || data?.postcode || data?.zip_code || data?.zip || ''),
      department: sanitizeAddressText(data?.department || '', 80),
      query_hint: sanitizeAddressLongText(data?.query_hint || data?.query || data?.full_text || '', 120),
      label: sanitizeAddressAlias(data?.label || data?.alias || ''),
      full_text: sanitizeAddressLongText(data?.full_text || data?.full || data?.display_name || '', 200),
      lat: Number.isFinite(latNum) ? Number(latNum.toFixed(6)) : null,
      lon: Number.isFinite(lonNum) ? Number(lonNum.toFixed(6)) : null,
      instrucciones: sanitizeDeliveryNotes(data?.instrucciones || data?.instructions || data?.delivery_notes || '')
    };
    if (!payload.barrio && !payload.calle && !payload.numeracion && !payload.instrucciones && payload.lat === null && payload.lon === null) return;
    localStorage.setItem(DELIVERY_ADDRESS_CACHE_KEY, JSON.stringify(payload));
  }catch(_){ }
}

function normalizeLocationPrefill(raw){
  try{
    const latNum = Number(raw?.lat);
    const lonNum = Number(raw?.lon);
    const scoreNum = Number(raw?.provider_score);
    const addrTypeRaw = sanitizeAddressText(raw?.provider_addr_type || raw?.addr_type || '', 40);
    const precisionRaw = normalizeRegionToken(raw?.precision_level || raw?.precision || '');
    const requiresPinAdjustmentRaw = !!raw?.requires_pin_adjustment;
    const queryHint = sanitizeAddressLongText(raw?.query_hint || raw?.query || '', 120);
    const rawPostalCode = normalizePostalCodeToken(
      raw?.postal_code ||
      raw?.postcode ||
      raw?.zip_code ||
      raw?.zip ||
      raw?.full_text ||
      raw?.label ||
      raw?.query_hint ||
      raw?.query ||
      ''
    );
    const hintedDepartment = sanitizeAddressText(
      raw?.department ||
      findDepartmentInHints([raw?.department, raw?.barrio, raw?.full_text, raw?.label, queryHint]) ||
      inferDepartmentFromPostalAndHints(rawPostalCode, [raw?.barrio, raw?.full_text, raw?.label, queryHint]) ||
      '',
      80
    );
    const postalCode = selectPostalForDepartment(rawPostalCode, hintedDepartment, [
      raw?.full_text,
      raw?.label,
      raw?.barrio,
      queryHint
    ]);
    const department = sanitizeAddressText(
      hintedDepartment ||
      inferDepartmentFromPostalAndHints(postalCode, [raw?.barrio, raw?.full_text, raw?.label, queryHint]) ||
      '',
      80
    );
    return {
      lat: Number.isFinite(latNum) ? latNum : null,
      lon: Number.isFinite(lonNum) ? lonNum : null,
      barrio: String(raw?.barrio || '').trim(),
      calle: String(raw?.calle || '').trim(),
      numeracion: String(raw?.numeracion || raw?.numero || '').trim(),
      postal_code: postalCode,
      department,
      label: String(raw?.label || raw?.display_name || '').trim(),
      full_text: sanitizeAddressLongText(raw?.full_text || raw?.full || raw?.display_name || raw?.label || '', 200),
      query_hint: queryHint,
      source: String(raw?.source || '').trim().toLowerCase(),
      provider_score: Number.isFinite(scoreNum) ? scoreNum : null,
      provider_addr_type: addrTypeRaw,
      precision_level: precisionRaw === 'exact' ? 'exact' : (precisionRaw === 'approx' ? 'approx' : ''),
      requires_pin_adjustment: requiresPinAdjustmentRaw,
      ts: Number(raw?.ts || Date.now()) || Date.now(),
    };
  }catch(_){
    return {
      lat: null,
      lon: null,
      barrio: '',
      calle: '',
      numeracion: '',
      postal_code: '',
      department: '',
      label: '',
      full_text: '',
      query_hint: '',
      source: '',
      provider_score: null,
      provider_addr_type: '',
      precision_level: '',
      requires_pin_adjustment: false,
      ts: Date.now()
    };
  }
}

function loadLocationPrefillCache(){
  try{
    const raw = localStorage.getItem(LOCATION_PREFILL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const normalized = normalizeLocationPrefill(parsed || {});
    if (normalized.lat === null || normalized.lon === null) return null;
    return normalized;
  }catch(_){ return null; }
}

function saveLocationPrefillCache(data){
  try{
    const normalized = normalizeLocationPrefill(data || {});
    if (normalized.lat === null || normalized.lon === null) return;
    localStorage.setItem(LOCATION_PREFILL_CACHE_KEY, JSON.stringify(normalized));
  }catch(_){ }
}

function buildLocationDisplayLabel(prefill){
  try{
    if (!prefill) return '';
    const full = String(prefill.full_text || '').trim();
    if (full) return full;
    const explicit = String(prefill.label || '').trim();
    if (explicit) return explicit;
    const parts = [prefill.calle, prefill.numeracion, prefill.barrio, prefill.department, normalizePostalCodeToken(prefill.postal_code || '')]
      .map(v => String(v || '').trim())
      .filter(Boolean);
    if (parts.length) return parts.join(', ');
    if (prefill.lat != null && prefill.lon != null){
      return `Lat ${Number(prefill.lat).toFixed(5)}, Lon ${Number(prefill.lon).toFixed(5)}`;
    }
    return '';
  }catch(_){ return ''; }
}

function buildCompactLocationLabel(prefill, maxParts = 3){
  const raw = buildLocationDisplayLabel(prefill);
  if (!raw) return '';
  const parts = raw.split(',').map(p => String(p || '').trim()).filter(Boolean);
  if (parts.length <= maxParts) return raw;
  return parts.slice(0, maxParts).join(', ');
}

function buildAuthLocationMapUrl(lat, lon){
  try{
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return '';
    const delta = 0.0022;
    const left = (lonNum - delta).toFixed(6);
    const right = (lonNum + delta).toFixed(6);
    const bottom = (latNum - delta).toFixed(6);
    const top = (latNum + delta).toFixed(6);
    const params = new URLSearchParams({
      bbox: `${left},${bottom},${right},${top}`,
      layer: 'mapnik',
      marker: `${latNum.toFixed(6)},${lonNum.toFixed(6)}`,
    });
    return `https://www.openstreetmap.org/export/embed.html?${params.toString()}`;
  }catch(_){ return ''; }
}

function getAuthLocationLatLon(prefill){
  const lat = Number(prefill?.lat);
  const lon = Number(prefill?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function hasLeafletForAuthLocation(){
  return typeof window !== 'undefined' && !!window.L && typeof window.L.map === 'function';
}

function createLeafletPinIcon(className = '__map_pin'){
  try{
    if (!hasLeafletForAuthLocation()) return null;
    const L = window.L;
    return L.divIcon({
      className,
      html: '<span></span>',
      iconSize: [28, 28],
      iconAnchor: [14, 24],
      popupAnchor: [0, -22]
    });
  }catch(_){ return null; }
}

function createLeafletBaseLayer(){
  try{
    if (!hasLeafletForAuthLocation()) return null;
    const L = window.L;
    return L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    });
  }catch(_){ return null; }
}

async function applyManualAuthLocationFromMap(lat, lon){
  try{
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return;
    setAuthLocationStatus('Actualizando dirección desde el mapa...');
    const previousPostal = normalizePostalCodeToken(authLocationPrefill?.postal_code || authLocationPrefill?.query_hint || '');
    const previousDepartment = sanitizeAddressText(
      authLocationPrefill?.department ||
      inferDepartmentFromPostalAndHints(previousPostal, [authLocationPrefill?.barrio, authLocationPrefill?.full_text, authLocationPrefill?.query_hint]) ||
      '',
      80
    );
    let prefill = normalizeLocationPrefill({ lat: latNum, lon: lonNum, ts: Date.now() });
    try{
      const reverse = await reverseGeocodeLocation(latNum, lonNum);
      if (reverse) prefill = reverse;
    }catch(_){ }
    if (!prefill.postal_code && previousPostal) prefill.postal_code = previousPostal;
    if (!prefill.department){
      prefill.department = previousDepartment || sanitizeAddressText(
        inferDepartmentFromPostalAndHints(prefill.postal_code, [prefill.barrio, prefill.full_text]),
        80
      );
    }
    authLocationPrefill = prefill;
    saveLocationPrefillCache(prefill);
    if (prefill.barrio || prefill.calle || prefill.numeracion){
      saveDeliveryAddressCache(prefill);
    }
    applyLocationToRegisterFields(prefill, { onlyEmpty: true });
    updateAuthLocationCard(prefill, 'Ubicación ajustada con el pin.');
  }catch(_){
    updateAuthLocationCard(authLocationPrefill, 'No se pudo actualizar la ubicación desde el mapa.');
  }
}

function syncAuthLocationMapPreview(prefill){
  try{
    const mapWrap = document.getElementById('authLocationMapWrap');
    const mapCanvas = document.getElementById('authLocationMapCanvas');
    const mapFrame = document.getElementById('authLocationMap');
    const latLon = getAuthLocationLatLon(prefill);
    if (!mapWrap) return;
    if (!latLon){
      mapWrap.hidden = true;
      if (mapFrame) mapFrame.src = '';
      return;
    }
    mapWrap.hidden = false;
    const leafletReady = hasLeafletForAuthLocation() && !!mapCanvas;
    if (leafletReady){
      const L = window.L;
      if (!authLocationMapInstance){
        authLocationMapInstance = L.map(mapCanvas, {
          zoomControl: true,
          attributionControl: true,
          scrollWheelZoom: true,
          preferCanvas: true,
        });
        const baseLayer = createLeafletBaseLayer();
        if (baseLayer) baseLayer.addTo(authLocationMapInstance);
        authLocationMapMarker = L.marker([latLon.lat, latLon.lon], { draggable: true, icon: createLeafletPinIcon('__map_pin __map_pin--auth') || undefined }).addTo(authLocationMapInstance);
        authLocationMapMarker.on('dragend', async () => {
          try{
            const point = authLocationMapMarker.getLatLng();
            await applyManualAuthLocationFromMap(point.lat, point.lng);
          }catch(_){ }
        });
        authLocationMapInstance.on('click', async (ev) => {
          try{
            const point = ev && ev.latlng ? ev.latlng : null;
            if (!point) return;
            if (authLocationMapMarker) authLocationMapMarker.setLatLng(point);
            await applyManualAuthLocationFromMap(point.lat, point.lng);
          }catch(_){ }
        });
      } else if (!authLocationMapMarker){
        authLocationMapMarker = L.marker([latLon.lat, latLon.lon], { draggable: true, icon: createLeafletPinIcon('__map_pin __map_pin--auth') || undefined }).addTo(authLocationMapInstance);
      }
      if (authLocationMapMarker) authLocationMapMarker.setLatLng([latLon.lat, latLon.lon]);
      authLocationMapInstance.setView([latLon.lat, latLon.lon], 17, { animate: false });
      if (mapCanvas) mapCanvas.hidden = false;
      if (mapFrame){
        mapFrame.hidden = true;
        mapFrame.src = '';
      }
      setTimeout(() => {
        try{ authLocationMapInstance.invalidateSize(); }catch(_){ }
      }, 50);
      return;
    }
    // Fallback sin Leaflet: mapa embebido estático.
    const mapUrl = buildAuthLocationMapUrl(latLon.lat, latLon.lon);
    if (mapFrame){
      mapFrame.hidden = false;
      if (mapUrl) mapFrame.src = mapUrl;
    }
    if (mapCanvas) mapCanvas.hidden = true;
  }catch(_){ }
}

function applyLocationToRegisterFields(prefill, options = {}){
  const onlyEmpty = options?.onlyEmpty !== false;
  if (!prefill) return;
  try{
    const barrioEl = document.getElementById('regBarrio');
    const calleEl = document.getElementById('regCalle');
    const numEl = document.getElementById('regNumero');
    if (barrioEl && (!onlyEmpty || !String(barrioEl.value || '').trim())) barrioEl.value = String(prefill.barrio || '').trim();
    if (calleEl && (!onlyEmpty || !String(calleEl.value || '').trim())) calleEl.value = String(prefill.calle || '').trim();
    if (numEl && (!onlyEmpty || !String(numEl.value || '').trim())) numEl.value = String(prefill.numeracion || '').trim();
  }catch(_){ }
}

function setAuthLocationStatus(message){
  try{
    const statusEl = document.getElementById('authLocationStatus');
    if (statusEl) statusEl.textContent = String(message || '').trim();
  }catch(_){ }
}

function updateAuthLocationCard(prefill, statusMessage = ''){
  try{
    if (statusMessage) setAuthLocationStatus(statusMessage);
    const normalized = prefill ? normalizeLocationPrefill(prefill) : null;
    const addressEl = document.getElementById('authLocationAddress');
    const applyBtn = document.getElementById('authApplyLocationBtn');
    const label = buildLocationDisplayLabel(normalized);
    if (addressEl) addressEl.value = label || 'Ubicación no confirmada todavía';
    if (applyBtn) applyBtn.disabled = !normalized;
    syncAuthLocationMapPreview(normalized);
  }catch(_){ }
}

function setAuthLocationLoading(isLoading){
  try{
    const btn = document.getElementById('authUseLocationBtn');
    if (!btn) return;
    btn.disabled = !!isLoading;
    btn.textContent = isLoading ? 'Buscando ubicación...' : 'Usar mi ubicación';
  }catch(_){ }
}

async function reverseGeocodeLocation(lat, lon){
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return null;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(latNum))}&lon=${encodeURIComponent(String(lonNum))}&accept-language=es`;
  const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' }, mode: 'cors' }, 10000);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') return null;
  const addr = (data.address && typeof data.address === 'object') ? data.address : {};
  const barrio = String(addr.suburb || addr.neighbourhood || addr.city_district || addr.city || addr.town || addr.village || '').trim();
  const calle = String(addr.road || addr.pedestrian || addr.residential || addr.path || '').trim();
  const numeracion = String(addr.house_number || '').trim();
  const postalCode = normalizePostalCodeToken(addr.postcode || data.postcode || data.display_name || '');
  const department = sanitizeAddressText(
    String(
      addr.county ||
      addr.state_district ||
      findDepartmentInHints([data.display_name, barrio, addr.city_district, addr.city]) ||
      inferDepartmentFromPostalAndHints(postalCode, [addr.city_district, addr.city, barrio, data.display_name]) ||
      ''
    ).trim(),
    80
  );
  const safePostalCode = selectPostalForDepartment(postalCode, department, [data.display_name, barrio, calle, numeracion]);
  const labelFromParts = [calle, numeracion, barrio].filter(Boolean).join(', ');
  const label = labelFromParts || String(data.display_name || '').split(',').slice(0, 3).join(',').trim();
  const fullText = sanitizeAddressLongText(data.display_name || label, 200);
  return normalizeLocationPrefill({
    lat: latNum,
    lon: lonNum,
    barrio,
    calle,
    numeracion,
    postal_code: safePostalCode,
    department,
    label,
    full_text: fullText,
    ts: Date.now(),
  });
}

function normalizeAddressSuggestion(item){
  if (!item || typeof item !== 'object') return null;
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const addr = (item.address && typeof item.address === 'object') ? item.address : {};
  const derived = extractAddressPartsFromDisplay(item.display_name || item.label || '');
  const barrio = sanitizeAddressText(
    item.barrio ||
    addr.suburb ||
    addr.neighbourhood ||
    addr.city_district ||
    addr.city ||
    addr.town ||
    addr.village ||
    addr.state_district ||
    addr.state ||
    derived.barrio ||
    '',
    80
  );
  const streetCandidate = sanitizeAddressText(
    item.calle ||
    addr.road ||
    addr.pedestrian ||
    addr.residential ||
    addr.path ||
    addr.footway ||
    derived.calle ||
    '',
    80
  );
  const streetInfo = parseStreetAndNumber(streetCandidate);
  const calle = sanitizeAddressText(streetInfo.calle || streetCandidate || '', 80);
  const numeracion = sanitizeAddressNumber(
    item.numeracion ||
    item.numero ||
    addr.house_number ||
    derived.numeracion ||
    streetInfo.numeracion ||
    ''
  ) || 'S/N';
  const postalCode = normalizePostalCodeToken(
    item.postal_code ||
    item.postcode ||
    item.zip_code ||
    addr.postcode ||
    item.query_hint ||
    item.query ||
    item.display_name ||
    item.label ||
    ''
  );
  const department = sanitizeAddressText(
    item.department ||
    addr.county ||
    addr.state_district ||
    findDepartmentInHints([item.query_hint, item.query, item.display_name, item.full_text, item.label, barrio]) ||
    inferDepartmentFromPostalAndHints(postalCode, [
      item.display_name,
      item.full_text,
      item.label,
      barrio,
      addr.city_district,
      addr.city,
      addr.town
    ]) ||
    '',
    80
  );
  const safePostalCode = selectPostalForDepartment(postalCode, department, [
    item.query_hint,
    item.query,
    item.display_name,
    item.full_text,
    item.label,
    barrio
  ]);
  const fullText = sanitizeAddressLongText(item.display_name || item.full_text || '', 200);
  const label = sanitizeAddressLongText(
    item.label ||
    [calle, numeracion, barrio].filter(Boolean).join(', ') ||
    fullText.split(',').slice(0, 3).join(','),
    120
  );
  return normalizeLocationPrefill({
    lat,
    lon,
    barrio,
    calle,
    numeracion,
    postal_code: safePostalCode,
    department,
    query_hint: sanitizeAddressLongText(item.query_hint || item.query || '', 120),
    label,
    full_text: fullText || label,
    source: 'nominatim',
    ts: Date.now()
  });
}

function locationPrefillToAddress(prefill, extra = {}){
  const normalized = normalizeLocationPrefill(prefill || {});
  const alias = sanitizeAddressAlias(extra.label || '');
  const fromText = extractAddressPartsFromDisplay(normalized.full_text || normalized.label || '');
  const streetParsed = parseStreetAndNumber(normalized.calle || fromText.calle || '');
  const barrio = sanitizeAddressText(normalized.barrio || fromText.barrio || 'Mendoza', 80);
  const calle = sanitizeAddressText(streetParsed.calle || normalized.calle || fromText.calle || '', 80);
  const numeracion = sanitizeAddressNumber(normalized.numeracion || fromText.numeracion || streetParsed.numeracion || '') || 'S/N';
  const rawPostalCode = normalizePostalCodeToken(
    normalized.postal_code ||
    normalized.query_hint ||
    normalized.full_text ||
    normalized.label ||
    ''
  );
  const department = sanitizeAddressText(
    normalized.department ||
    findDepartmentInHints([normalized.query_hint, normalized.full_text, normalized.label, normalized.barrio]) ||
    inferDepartmentFromPostalAndHints(rawPostalCode, [normalized.barrio, normalized.full_text, normalized.label, normalized.query_hint]) ||
    '',
    80
  );
  const postalCode = selectPostalForDepartment(rawPostalCode, department, [
    normalized.query_hint,
    normalized.full_text,
    normalized.label,
    normalized.barrio
  ]);
  const check = validateAddressInput({
    label: alias,
    barrio,
    calle,
    numeracion
  }, {
    requireAlias: false
  });
  if (!check.ok) return null;
  return Object.assign({}, check.value, {
    postal_code: postalCode,
    department,
    query_hint: sanitizeAddressLongText(normalized.query_hint || normalized.full_text || normalized.label || '', 120),
    lat: normalized.lat,
    lon: normalized.lon,
    full_text: sanitizeAddressLongText(normalized.full_text || normalized.label || buildLocationDisplayLabel(normalized), 200)
  });
}

function buildAddressSearchQueryVariants(query){
  const clean = sanitizeAddressLongText(query || '', 120);
  if (!clean) return [];
  const variants = [];
  const expanded = expandAddressAbbreviationsForSearch(clean);
  const parsedStreetInfo = parseStreetAndNumber(clean);
  const parsedStreet = sanitizeAddressText(parsedStreetInfo.calle || '', 90);
  const parsedNumber = sanitizeAddressNumber(parsedStreetInfo.numeracion || '');
  const postalCode = normalizePostalCodeToken(clean);
  const textDepartmentHints = extractDepartmentsFromQueryText(clean);
  const postalDepartmentHints = getDepartmentsForPostalToken(postalCode);
  const departmentHints = Array.from(new Set(
    textDepartmentHints.length ? textDepartmentHints : postalDepartmentHints
  )).filter(Boolean);
  const add = (value) => {
    const v = sanitizeAddressLongText(value || '', 120);
    if (!v) return;
    if (!variants.includes(v)) variants.push(v);
  };
  const withRegion = isMendozaText(clean) ? clean : `${clean}, Mendoza, Argentina`;
  add(withRegion);
  add(clean);
  if (parsedStreet){
    const titleStreet = toAddressTitleCase(parsedStreet);
    const streetWithNumber = [titleStreet || parsedStreet, parsedNumber].filter(Boolean).join(' ').trim();
    if (streetWithNumber){
      add(streetWithNumber);
      add(`${streetWithNumber}, Mendoza, Argentina`);
      departmentHints.forEach((dep) => add(`${streetWithNumber}, ${dep}, Mendoza, Argentina`));
    }
    const streetOnly = titleStreet || parsedStreet;
    if (streetOnly){
      add(`${streetOnly}, Mendoza, Argentina`);
      departmentHints.forEach((dep) => add(`${streetOnly}, ${dep}, Mendoza, Argentina`));
    }
  }
  if (expanded && expanded !== clean){
    add(expanded);
    add(isMendozaText(expanded) ? expanded : `${expanded}, Mendoza, Argentina`);
    departmentHints.forEach((dep) => add(`${expanded}, ${dep}, Mendoza, Argentina`));
  }
  departmentHints.forEach((dep) => add(`${clean}, ${dep}, Mendoza, Argentina`));
  const titleCase = toAddressTitleCase(clean);
  if (titleCase && titleCase !== clean){
    add(`${titleCase}, Mendoza, Argentina`);
    add(titleCase);
    departmentHints.forEach((dep) => add(`${titleCase}, ${dep}, Mendoza, Argentina`));
  }
  const noNumber = clean
    .replace(/\b\d{1,6}[A-Za-z]?\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (noNumber && noNumber !== clean){
    add(`${noNumber}, Mendoza, Argentina`);
    departmentHints.forEach((dep) => add(`${noNumber}, ${dep}, Mendoza, Argentina`));
    add(`${noNumber}, Las Heras, Mendoza, Argentina`);
  }
  if (titleCase && titleCase !== clean){
    const noNumberTitle = titleCase
      .replace(/\b\d{1,6}[A-Za-z]?\b/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (noNumberTitle && noNumberTitle !== titleCase){
      add(`${noNumberTitle}, Mendoza, Argentina`);
      departmentHints.forEach((dep) => add(`${noNumberTitle}, ${dep}, Mendoza, Argentina`));
      add(`${noNumberTitle}, Las Heras, Mendoza, Argentina`);
    }
  }
  add(`${clean}, Las Heras, Mendoza, Argentina`);
  if (titleCase && titleCase !== clean) add(`${titleCase}, Las Heras, Mendoza, Argentina`);
  return variants;
}

function buildSuggestionRankingScore(query, suggestion){
  try{
    const qRaw = normalizeRegionToken(query || '');
    const sRaw = normalizeRegionToken(buildLocationDisplayLabel(suggestion) || '');
    if (!qRaw || !sRaw) return 0;
    const qStreetInfo = parseStreetAndNumber(qRaw);
    const qNum = normalizeRegionToken(qStreetInfo.numeracion || '');
    const qStreet = normalizeRegionToken(
      qStreetInfo.calle ||
      stripAddressContextTokens(qRaw.replace(/\b\d{1,6}[a-z]?\b/gi, ' '))
    );
    const sStreetInfo = parseStreetAndNumber(normalizeRegionToken(suggestion?.calle || ''));
    const sStreet = normalizeRegionToken(sStreetInfo.calle || suggestion?.calle || '');
    const sNum = normalizeRegionToken(suggestion?.numeracion || sStreetInfo.numeracion || '');
    const qPostal = normalizePostalCodeToken(query || qRaw);
    const sPostal = normalizePostalCodeToken(
      suggestion?.postal_code ||
      suggestion?.postcode ||
      suggestion?.zip_code ||
      buildLocationDisplayLabel(suggestion) ||
      ''
    );
    const qPostalDigits = extractNormalizedPostalToken(qPostal);
    const sPostalDigits = extractNormalizedPostalToken(sPostal);
    const explicitDepartments = extractDepartmentsFromQueryText(qRaw);
    const qDepartments = Array.from(new Set(
      explicitDepartments.length ? explicitDepartments : getDepartmentsForPostalToken(qPostal)
    )).filter(Boolean);
    const sDepartmentToken = normalizeRegionToken(
      suggestion?.department ||
      inferDepartmentFromPostalAndHints(sPostal, [suggestion?.full_text, suggestion?.label, suggestion?.barrio]) ||
      ''
    );
    let score = 0;
    if (qNum && sNum && qNum === sNum) score += 11;
    else if (qNum && (hasNormalizedWordToken(sRaw, qNum) || sRaw.includes(qNum))) score += 8;
    if (qStreet && sStreet && (sStreet === qStreet || qStreet === sStreet)) score += 12;
    else if (qStreet && sStreet && (sStreet.includes(qStreet) || qStreet.includes(sStreet))) score += 10;
    if (qStreet && sRaw.includes(qStreet)) score += 7;
    const streetTokens = qStreet
      .split(' ')
      .filter((token) => token.length >= 3 && !ADDRESS_QUERY_STOPWORDS.has(token));
    let hits = 0;
    streetTokens.forEach((token) => { if (sRaw.includes(token)) hits += 1; });
    score += Math.min(5, hits);
    if (qDepartments.length){
      const depMatch = qDepartments.some((dep) => {
        const depToken = normalizeRegionToken(dep);
        return depToken && (sRaw.includes(depToken) || sDepartmentToken === depToken);
      });
      if (depMatch) score += 12;
      else score -= 8;
    }
    if (!explicitDepartments.length && qPostalDigits && sPostalDigits){
      if (qPostalDigits === sPostalDigits) score += 8;
      else score -= 3;
    }
    if (suggestion && suggestion.calle) score += 1.5;
    if (normalizeRegionToken(suggestion?.source || '') === 'arcgis') score += 2;
    const arcAddrType = normalizeArcGisAddrType(suggestion?.provider_addr_type || '');
    if (qNum && arcAddrType){
      if (isArcGisPointAddressType(arcAddrType)) score += 10;
      else if (arcAddrType.includes('streetname')) score -= 4;
      else if (arcAddrType.includes('poi') || arcAddrType.includes('locality') || arcAddrType.includes('postal')) score -= 8;
    }
    const providerScore = Number(suggestion?.provider_score);
    if (Number.isFinite(providerScore) && providerScore > 0){
      score += Math.min(5, providerScore / 20);
    }
    return score;
  }catch(_){ return 0; }
}

function getManualMapSeedPrefill(query){
  const cached = loadLocationPrefillCache();
  const base = (cached && isMendozaPrefill(cached))
    ? normalizeLocationPrefill(cached)
    : normalizeLocationPrefill({
        lat: MENDOZA_DEFAULT_CENTER.lat,
        lon: MENDOZA_DEFAULT_CENTER.lon,
        barrio: 'Mendoza',
        label: 'Mendoza, Argentina',
        full_text: 'Mendoza, Argentina',
        ts: Date.now()
      });
  const cleanQuery = sanitizeAddressLongText(query || '', 120);
  if (!cleanQuery) return base;
  const parsed = extractAddressPartsFromDisplay(cleanQuery);
  const rawPostalCode = normalizePostalCodeToken(cleanQuery);
  const department = sanitizeAddressText(
    findDepartmentInHints([cleanQuery, parsed.barrio]) ||
    inferDepartmentFromPostalAndHints(rawPostalCode, [cleanQuery, parsed.barrio]) ||
    '',
    80
  );
  const postalCode = selectPostalForDepartment(rawPostalCode, department, [cleanQuery, parsed.barrio]);
  return normalizeLocationPrefill({
    lat: base.lat,
    lon: base.lon,
    barrio: parsed.barrio || base.barrio || 'Mendoza',
    calle: parsed.calle || base.calle || '',
    numeracion: parsed.numeracion || base.numeracion || '',
    postal_code: postalCode,
    department,
    label: cleanQuery,
    full_text: isMendozaText(cleanQuery) ? cleanQuery : `${cleanQuery}, Mendoza, Argentina`,
    ts: Date.now()
  });
}

function normalizeArcGisSuggestion(candidate){
  try{
    if (!candidate || typeof candidate !== 'object') return null;
    const loc = candidate.location && typeof candidate.location === 'object' ? candidate.location : {};
    const attrs = candidate.attributes && typeof candidate.attributes === 'object' ? candidate.attributes : {};
    const lat = Number(loc.y);
    const lon = Number(loc.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const addressLineRaw = sanitizeAddressLongText(candidate.address || candidate.Match_addr || '', 200);
    if (!addressLineRaw) return null;
    const addressLine = /mendoza/i.test(addressLineRaw)
      ? addressLineRaw
      : (addressLineRaw + ', Mendoza, Argentina');
    const parsed = extractAddressPartsFromDisplay(addressLine);
    const firstSegment = String(addressLine.split(',')[0] || '').trim();
    const streetParsed = parseStreetAndNumber(parsed.calle || firstSegment || '');
    const calle = sanitizeAddressText(
      String(streetParsed.calle || parsed.calle || firstSegment || '').replace(/^calle\s+/i, ''),
      80
    );
    const numeracion = sanitizeAddressNumber(parsed.numeracion || streetParsed.numeracion || '') || 'S/N';
    const barrio = sanitizeAddressText(parsed.barrio || String(addressLine.split(',')[1] || 'Mendoza'), 80);
    const rawPostalCode = normalizePostalCodeToken(attrs.Postal || addressLine || '');
    const department = sanitizeAddressText(
      attrs.Subregion ||
      attrs.District ||
      findDepartmentInHints([addressLine, barrio, attrs.City, attrs.Subregion, attrs.District]) ||
      inferDepartmentFromPostalAndHints(rawPostalCode, [addressLine, barrio, attrs.City]) ||
      '',
      80
    );
    const postalCode = selectPostalForDepartment(rawPostalCode, department, [addressLine, barrio, attrs.City, attrs.Subregion, attrs.District]);
    const label = sanitizeAddressLongText([calle, numeracion, barrio].filter(Boolean).join(', '), 120);
    const addrType = sanitizeAddressText(attrs.Addr_type || attrs.Type || '', 40);
    return normalizeLocationPrefill({
      lat,
      lon,
      barrio: barrio || 'Mendoza',
      calle,
      numeracion,
      postal_code: postalCode,
      department,
      label,
      full_text: addressLine,
      source: 'arcgis',
      provider_score: Number(candidate.score),
      provider_addr_type: addrType,
      ts: Date.now(),
    });
  }catch(_){ return null; }
}

async function fetchArcGisAddressSuggestions(query, { limit = 6, signal = null } = {}){
  const clean = sanitizeAddressLongText(query || '', 120);
  if (clean.length < 3) return [];
  try{
    const params = new URLSearchParams({
      SingleLine: clean,
      f: 'pjson',
      countryCode: 'ARG',
      maxLocations: String(Math.min(8, Math.max(1, Number(limit) || 6))),
      forStorage: 'false',
      outFields: '*',
      location: `${MENDOZA_DEFAULT_CENTER.lon},${MENDOZA_DEFAULT_CENTER.lat}`,
      searchExtent: `${MENDOZA_BOUNDS.minLon},${MENDOZA_BOUNDS.minLat},${MENDOZA_BOUNDS.maxLon},${MENDOZA_BOUNDS.maxLat}`,
    });
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?${params.toString()}`;
    const res = await fetch(url, {
      mode: 'cors',
      signal,
      headers: { 'Accept': 'application/json' }
    });
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data && data.candidates) ? data.candidates : [];
    return list
      .map(normalizeArcGisSuggestion)
      .filter((item) => item && isMendozaPrefill(item));
  }catch(_){
    return [];
  }
}

async function fetchArcGisStructuredAddressSuggestions({
  street = '',
  number = '',
  department = '',
  barrio = '',
  postalCode = '',
  limit = 8,
  signal = null
} = {}){
  const cleanStreet = sanitizeAddressText(street || '', 90);
  const cleanNumber = sanitizeAddressNumber(number || '');
  if (!cleanStreet) return [];
  try{
    const cityHint = sanitizeAddressText(
      department ||
      findDepartmentInHints([department, barrio, cleanStreet]) ||
      barrio ||
      '',
      80
    );
    const postalDigits = extractNormalizedPostalToken(postalCode);
    const params = new URLSearchParams({
      Address: [cleanStreet, cleanNumber].filter(Boolean).join(' ').trim(),
      Region: 'Mendoza',
      CountryCode: 'ARG',
      f: 'pjson',
      maxLocations: String(Math.min(10, Math.max(1, Number(limit) || 8))),
      forStorage: 'false',
      outFields: '*',
      location: `${MENDOZA_DEFAULT_CENTER.lon},${MENDOZA_DEFAULT_CENTER.lat}`,
      searchExtent: `${MENDOZA_BOUNDS.minLon},${MENDOZA_BOUNDS.minLat},${MENDOZA_BOUNDS.maxLon},${MENDOZA_BOUNDS.maxLat}`,
    });
    if (cityHint) params.set('City', cityHint);
    if (postalDigits) params.set('Postal', postalDigits);
    if (cleanNumber) params.set('category', 'Address');
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?${params.toString()}`;
    const res = await fetch(url, {
      mode: 'cors',
      signal,
      headers: { 'Accept': 'application/json' }
    });
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data && data.candidates) ? data.candidates : [];
    return list
      .map(normalizeArcGisSuggestion)
      .filter((item) => item && isMendozaPrefill(item));
  }catch(_){
    return [];
  }
}

async function fetchArcGisSuggestSuggestions(text, { limit = 10, signal = null } = {}){
  const clean = sanitizeAddressLongText(text || '', 140);
  if (!clean) return [];
  try{
    const params = new URLSearchParams({
      f: 'pjson',
      text: clean,
      countryCode: 'ARG',
      maxSuggestions: String(Math.min(15, Math.max(1, Number(limit) || 10))),
      location: `${MENDOZA_DEFAULT_CENTER.lon},${MENDOZA_DEFAULT_CENTER.lat}`,
      searchExtent: `${MENDOZA_BOUNDS.minLon},${MENDOZA_BOUNDS.minLat},${MENDOZA_BOUNDS.maxLon},${MENDOZA_BOUNDS.maxLat}`,
    });
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?${params.toString()}`;
    const res = await fetch(url, {
      mode: 'cors',
      signal,
      headers: { 'Accept': 'application/json' }
    });
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data && data.suggestions) ? data.suggestions : [];
    return list
      .map((item) => ({
        text: sanitizeAddressLongText(item && item.text || '', 180),
        magicKey: String(item && item.magicKey || '').trim(),
        isCollection: !!(item && item.isCollection)
      }))
      .filter((item) => !!item.text && !!item.magicKey && !item.isCollection);
  }catch(_){
    return [];
  }
}

async function fetchArcGisCandidatesByMagicKey(suggestionText, magicKey, { limit = 5, signal = null } = {}){
  const text = sanitizeAddressLongText(suggestionText || '', 180);
  const key = String(magicKey || '').trim();
  if (!text || !key) return [];
  try{
    const params = new URLSearchParams({
      f: 'pjson',
      singleLine: text,
      magicKey: key,
      outFields: '*',
      forStorage: 'false',
      maxLocations: String(Math.min(8, Math.max(1, Number(limit) || 5))),
      location: `${MENDOZA_DEFAULT_CENTER.lon},${MENDOZA_DEFAULT_CENTER.lat}`,
      searchExtent: `${MENDOZA_BOUNDS.minLon},${MENDOZA_BOUNDS.minLat},${MENDOZA_BOUNDS.maxLon},${MENDOZA_BOUNDS.maxLat}`,
    });
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?${params.toString()}`;
    const res = await fetch(url, {
      mode: 'cors',
      signal,
      headers: { 'Accept': 'application/json' }
    });
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data && data.candidates) ? data.candidates : [];
    return list
      .map(normalizeArcGisSuggestion)
      .filter((item) => item && isMendozaPrefill(item));
  }catch(_){
    return [];
  }
}

function extractNumericHintsFromAddressText(text){
  try{
    const raw = String(text || '');
    if (!raw) return [];
    const matches = Array.from(raw.matchAll(/\b(\d{1,6})\b/g)).map((m) => String(m && m[1] || '').trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    matches.forEach((token) => {
      if (!token) return;
      if (token.length === 4 && isKnownMendozaPostalDigits(token)) return;
      const num = Number(token);
      if (!Number.isFinite(num) || num <= 0) return;
      if (seen.has(num)) return;
      seen.add(num);
      out.push(num);
    });
    return out.slice(0, 8);
  }catch(_){ return []; }
}

async function fetchArcGisStreetNumberAnchors({
  street = '',
  targetNumber = '',
  department = '',
  postalCode = '',
  signal = null
} = {}){
  const cleanStreet = sanitizeAddressText(street || '', 90);
  const targetNum = Number(sanitizeAddressNumber(targetNumber || ''));
  if (!cleanStreet || !Number.isFinite(targetNum) || targetNum <= 0) return [];
  try{
    const dep = sanitizeAddressText(department || 'Las Heras', 80);
    const postal = normalizePostalCodeToken(postalCode || '');
    const suggestQueries = [];
    const addSuggestQuery = (value) => {
      const v = sanitizeAddressLongText(value || '', 140);
      if (!v) return;
      if (!suggestQueries.includes(v)) suggestQueries.push(v);
    };
    addSuggestQuery(`${cleanStreet} ${targetNum}, ${dep}, Mendoza, Argentina`);
    addSuggestQuery(`${cleanStreet}, ${dep}, Mendoza, Argentina`);
    if (postal){
      addSuggestQuery(`${cleanStreet} ${targetNum}, ${dep}, ${postal}, Mendoza, Argentina`);
    }
    const anchors = [];
    const seen = new Set();
    for (const suggestQuery of suggestQueries){
      const suggestions = await fetchArcGisSuggestSuggestions(suggestQuery, { limit: 12, signal });
      for (const suggestion of suggestions){
        if (!suggestion || !suggestion.magicKey) continue;
        const suggestionToken = normalizeRegionToken(suggestion.text || '');
        const streetToken = normalizeRegionToken(cleanStreet);
        if (streetToken && suggestionToken && !suggestionToken.includes(streetToken)) continue;
        const numericHints = extractNumericHintsFromAddressText(suggestion.text || '');
        if (!numericHints.length) continue;
        const geocoded = await fetchArcGisCandidatesByMagicKey(suggestion.text, suggestion.magicKey, { limit: 3, signal });
        for (const candidate of geocoded){
          if (!candidate) continue;
          if (!suggestionMatchesStreetToken(candidate, cleanStreet)) continue;
          if (dep && !suggestionMatchesDepartmentToken(candidate, dep)) continue;
          const lat = Number(candidate.lat);
          const lon = Number(candidate.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isMendozaPrefill(candidate)) continue;
          const score = Number(candidate.provider_score);
          numericHints.forEach((numberHint) => {
            const key = `${numberHint}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
            if (seen.has(key)) return;
            seen.add(key);
            anchors.push({
              number: Number(numberHint),
              lat,
              lon,
              score: Number.isFinite(score) ? score : 0,
              candidate
            });
          });
        }
      }
    }
    return anchors;
  }catch(_){
    return [];
  }
}

function scorePrecisionCandidate(candidate, context = {}){
  try{
    if (!candidate || typeof candidate !== 'object') return -9999;
    const streetToken = normalizeRegionToken(context.street || '');
    const numberToken = sanitizeAddressNumber(context.number || '');
    const departmentToken = normalizeDepartmentToken(context.department || '');
    const postalToken = extractNormalizedPostalToken(context.postalCode || '');
    const baseLat = Number(context.baseLat);
    const baseLon = Number(context.baseLon);
    const candidatePostalToken = extractNormalizedPostalToken(candidate.postal_code || candidate.postcode || candidate.full_text || candidate.label || '');
    const candidateNumber = sanitizeAddressNumber(candidate.numeracion || '');
    const candidateAddrType = normalizeArcGisAddrType(candidate.provider_addr_type || '');
    const candidateText = normalizeRegionToken([candidate.full_text, candidate.label].filter(Boolean).join(' '));
    let score = 0;

    if (streetToken){
      if (suggestionMatchesStreetToken(candidate, streetToken)) score += 26;
      else score -= 24;
    }
    if (numberToken){
      const numberInText = hasNormalizedWordToken(candidateText, numberToken);
      if (candidateNumber && candidateNumber === numberToken) score += 30;
      else if (numberInText) score += 22;
      else if (/^s\/?n$/i.test(candidateNumber || '')) score -= 14;
      else score -= 22;
    }
    if (departmentToken){
      if (suggestionMatchesDepartmentToken(candidate, departmentToken)) score += 24;
      else score -= 26;
    }
    if (postalToken){
      if (candidatePostalToken && candidatePostalToken === postalToken) score += 10;
      else if (candidatePostalToken) score -= 8;
    }

    if (candidateAddrType){
      if (isArcGisPointAddressType(candidateAddrType)) score += 24;
      else if (candidateAddrType.includes('streetname')) score += 3;
      else if (candidateAddrType.includes('poi') || candidateAddrType.includes('locality') || candidateAddrType.includes('postal')) score -= 20;
    }

    if (normalizeRegionToken(candidate.source || '') === 'arcgis') score += 3;
    const providerScore = Number(candidate.provider_score);
    if (Number.isFinite(providerScore) && providerScore > 0){
      score += Math.min(8, providerScore / 12);
    }

    const candLat = Number(candidate.lat);
    const candLon = Number(candidate.lon);
    if (Number.isFinite(baseLat) && Number.isFinite(baseLon) && Number.isFinite(candLat) && Number.isFinite(candLon)){
      const km = haversineDistanceKm(baseLat, baseLon, candLat, candLon);
      if (Number.isFinite(km)) score -= Math.min(18, km * 1.5);
    }

    return score;
  }catch(_){ return -9999; }
}

function inferMapSeedPrecision(prefill, { street = '', number = '', department = '' } = {}){
  try{
    const result = Object.assign({}, prefill || {});
    const hasNumberHint = !!sanitizeAddressNumber(number || '');
    if (!hasNumberHint){
      result.precision_level = result.precision_level || 'exact';
      result.requires_pin_adjustment = false;
      return result;
    }
    const numberHint = sanitizeAddressNumber(number || '');
    const numberInResult = sanitizeAddressNumber(result.numeracion || '');
    const resultText = normalizeRegionToken([result.full_text, result.label].filter(Boolean).join(' '));
    const numberMatched = (!!numberInResult && numberInResult === numberHint) || hasNormalizedWordToken(resultText, numberHint);
    const streetMatched = suggestionMatchesStreetToken(result, street || result.calle || '');
    const departmentMatched = !department || suggestionMatchesDepartmentToken(result, department);
    const addrType = normalizeArcGisAddrType(result.provider_addr_type || '');
    const pointPrecision = isArcGisPointAddressType(addrType);
    const exact = numberMatched && streetMatched && departmentMatched && (pointPrecision || normalizeRegionToken(result.source || '') !== 'arcgis');
    result.precision_level = exact ? 'exact' : 'approx';
    result.requires_pin_adjustment = !exact;
    return result;
  }catch(_){
    return Object.assign({}, prefill || {}, { precision_level: 'approx', requires_pin_adjustment: true });
  }
}

async function resolveAddressSeedForMap(prefill, queryHint = ''){
  try{
    const base = normalizeAddressSuggestion(prefill) || normalizeLocationPrefill(prefill || {});
    const typedQuery = sanitizeAddressLongText(queryHint || base.query_hint || '', 120);
    const parsedTyped = parseStreetAndNumber(typedQuery);
    const streetHint = sanitizeAddressText(base.calle || parsedTyped.calle || '', 80);
    const numberHint = sanitizeAddressNumber(
      (base.numeracion && !/^s\/?n$/i.test(String(base.numeracion || ''))) ? base.numeracion : (parsedTyped.numeracion || '')
    );
    const departmentHint = sanitizeAddressText(
      base.department ||
      findDepartmentInHints([typedQuery, base.full_text, base.barrio, base.label]) ||
      inferDepartmentFromPostalAndHints(base.postal_code, [typedQuery, base.full_text, base.barrio]) ||
      '',
      80
    );
    const postalHint = selectPostalForDepartment(
      normalizePostalCodeToken(base.postal_code || typedQuery || base.full_text || ''),
      departmentHint,
      [typedQuery, base.full_text, base.barrio, departmentHint]
    );
    const hasStreetAndNumber = !!(streetHint && numberHint);
    if (!hasStreetAndNumber){
      return inferMapSeedPrecision(normalizeLocationPrefill(Object.assign({}, base, { query_hint: typedQuery || base.query_hint || '' })), {
        street: streetHint,
        number: numberHint,
        department: departmentHint
      });
    }

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (item) => {
      if (!item) return;
      const normalized = normalizeLocationPrefill(item);
      if (!isMendozaPrefill(normalized)) return;
      const key = `${Number(normalized.lat || 0).toFixed(6)}|${Number(normalized.lon || 0).toFixed(6)}|${normalizeRegionToken(normalized.full_text || normalized.label || '')}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(normalized);
    };

    const arcStructured = await fetchArcGisStructuredAddressSuggestions({
      street: streetHint,
      number: numberHint,
      department: departmentHint,
      barrio: base.barrio,
      postalCode: postalHint || base.postal_code,
      limit: 10,
    });
    arcStructured.forEach(pushCandidate);

    if (candidates.length < 4){
      const canonical = sanitizeAddressLongText(
        [streetHint, numberHint, departmentHint || base.barrio, postalHint, 'Mendoza', 'Argentina'].filter(Boolean).join(', '),
        120
      );
      const fromSearch = await fetchAddressSuggestions(canonical, { limit: 10 }).catch(() => []);
      (Array.isArray(fromSearch) ? fromSearch : []).forEach(pushCandidate);
    }

    pushCandidate(base);
    const context = {
      street: streetHint,
      number: numberHint,
      department: departmentHint,
      postalCode: postalHint,
      baseLat: base.lat,
      baseLon: base.lon
    };
    let best = normalizeLocationPrefill(Object.assign({}, base, { query_hint: typedQuery || base.query_hint || '' }));
    let bestScore = scorePrecisionCandidate(best, context);
    for (const candidate of candidates){
      const score = scorePrecisionCandidate(candidate, context);
      if (score > bestScore){
        best = candidate;
        bestScore = score;
      }
    }

    const merged = normalizeLocationPrefill(Object.assign({}, base, best, {
      query_hint: typedQuery || best.query_hint || base.query_hint || '',
      department: best.department || departmentHint,
      postal_code: selectPostalForDepartment(best.postal_code || postalHint, best.department || departmentHint, [
        typedQuery,
        best.full_text,
        best.barrio,
        departmentHint
      ])
    }));

    if (numberHint && /^s\/?n$/i.test(String(merged.numeracion || '')) && suggestionMatchesStreetToken(merged, streetHint)){
      merged.numeracion = numberHint;
      if (!merged.label || /s\/?n/i.test(String(merged.label || ''))){
        merged.label = sanitizeAddressLongText([merged.calle, merged.numeracion, merged.barrio].filter(Boolean).join(', '), 120);
      }
      if (!merged.full_text || !hasNormalizedWordToken(merged.full_text, numberHint)){
        merged.full_text = sanitizeAddressLongText(
          [merged.calle, merged.numeracion, merged.barrio, merged.department, normalizePostalCodeToken(merged.postal_code || '')]
            .filter(Boolean)
            .join(', '),
          200
        );
      }
    }
    let resolved = inferMapSeedPrecision(merged, {
      street: streetHint,
      number: numberHint,
      department: departmentHint
    });
    if (numberHint && resolved && resolved.requires_pin_adjustment){
      const anchors = await fetchArcGisStreetNumberAnchors({
        street: streetHint,
        targetNumber: numberHint,
        department: departmentHint || 'Las Heras',
        postalCode: postalHint || resolved.postal_code,
      }).catch(() => []);
      if (Array.isArray(anchors) && anchors.length){
        const targetNum = Number(numberHint);
        let bestAnchor = null;
        for (const anchor of anchors){
          const anchorNum = Number(anchor && anchor.number);
          if (!Number.isFinite(anchorNum) || anchorNum <= 0) continue;
          const anchorCandidate = anchor && anchor.candidate && typeof anchor.candidate === 'object'
            ? anchor.candidate
            : {};
          const sameDepartment = suggestionMatchesDepartmentToken(anchorCandidate, departmentHint || 'Las Heras');
          const sameStreet = suggestionMatchesStreetToken(anchorCandidate, streetHint);
          if (!sameStreet) continue;
          const numDiff = Math.abs(anchorNum - targetNum);
          const providerScore = Number(anchor && anchor.score);
          const anchorRank = (sameDepartment ? 50 : 0) - numDiff + (Number.isFinite(providerScore) ? Math.min(20, providerScore / 5) : 0);
          if (!bestAnchor || anchorRank > bestAnchor.rank){
            bestAnchor = { anchor, rank: anchorRank, numDiff };
          }
        }
        if (bestAnchor && bestAnchor.anchor && bestAnchor.numDiff <= 350){
          const anchorCandidate = bestAnchor.anchor.candidate || {};
          resolved = normalizeLocationPrefill(Object.assign({}, resolved, anchorCandidate, {
            lat: Number(bestAnchor.anchor.lat),
            lon: Number(bestAnchor.anchor.lon),
            calle: resolved.calle || anchorCandidate.calle || streetHint,
            numeracion: numberHint,
            department: resolved.department || anchorCandidate.department || departmentHint,
            postal_code: selectPostalForDepartment(
              resolved.postal_code || anchorCandidate.postal_code || postalHint,
              resolved.department || anchorCandidate.department || departmentHint,
              [resolved.full_text, resolved.barrio, departmentHint, postalHint]
            ),
            query_hint: typedQuery || resolved.query_hint || '',
            source: 'arcgis',
            precision_level: 'approx',
            requires_pin_adjustment: true,
          }));
          const postalText = normalizePostalCodeToken(resolved.postal_code || '');
          resolved.full_text = sanitizeAddressLongText(
            [resolved.calle, resolved.numeracion, resolved.barrio, resolved.department, postalText].filter(Boolean).join(', '),
            200
          );
          resolved.label = sanitizeAddressLongText(
            [resolved.calle, resolved.numeracion, resolved.barrio].filter(Boolean).join(', '),
            120
          );
        }
      }
    }
    return resolved;
  }catch(_){
    return normalizeAddressSuggestion(prefill) || normalizeLocationPrefill(prefill || {});
  }
}

function seedAddressBookFromKnownLocations(accountId = null){
  try{
    const bookBefore = loadAddressBook(accountId);
    let shouldSetDefault = !bookBefore.defaultId;
    const candidates = [];
    const cachedLocation = loadLocationPrefillCache();
    const deliveryCache = loadDeliveryAddressCache();
    if (cachedLocation) candidates.push(cachedLocation);
    if (deliveryCache) candidates.push(deliveryCache);
    for (const candidate of candidates){
      const payload = locationPrefillToAddress(candidate, { label: '' });
      if (!payload) continue;
      if (!isMendozaPrefill(payload)) continue;
      const saved = upsertAddressInBook(payload, { accountId, setDefault: shouldSetDefault });
      if (saved && saved.id){
        setLastUsedAddressId(saved.id, accountId);
        shouldSetDefault = false;
      }
    }
  }catch(_){ }
}

function getCurrentLocationPrefill(){
  return new Promise((resolve) => {
    try{
      if (!navigator.geolocation){
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(async (position) => {
        try{
          const lat = Number(position?.coords?.latitude);
          const lon = Number(position?.coords?.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) { resolve(null); return; }
          const reverse = await reverseGeocodeLocation(lat, lon);
          if (reverse) {
            resolve(reverse);
            return;
          }
          resolve(normalizeLocationPrefill({ lat, lon, ts: Date.now() }));
        }catch(_){
          resolve(null);
        }
      }, () => resolve(null), {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      });
    }catch(_){
      resolve(null);
    }
  });
}

async function fetchAddressSuggestions(query, { limit = 6 } = {}){
  const clean = sanitizeAddressLongText(query || '', 120);
  if (clean.length < 3) return [];
  const requestId = ++addressSearchActiveRequestId;
  try{
    if (addressSearchAbortController) addressSearchAbortController.abort();
  }catch(_){ }
  try{
    addressSearchAbortController = new AbortController();
    const queries = buildAddressSearchQueryVariants(clean);
    const out = [];
    const seen = new Set();
    const maxLimit = Math.min(12, Math.max(3, Number(limit) || 6));
    const queryToken = normalizeRegionToken(clean);
    const queryStreetInfo = parseStreetAndNumber(clean);
    const queryNumberHint = sanitizeAddressNumber(queryStreetInfo.numeracion || '');
    const queryStreetHintToken = normalizeRegionToken(queryStreetInfo.calle || '');
    const queryPostalCode = normalizePostalCodeToken(clean);
    const queryPostalDigits = extractNormalizedPostalToken(queryPostalCode);
    const explicitDepartments = extractDepartmentsFromQueryText(queryToken);
    const hasStreetAndNumber = !!(queryStreetHintToken && queryNumberHint);
    let preferredDepartments = Array.from(new Set(
      explicitDepartments.length ? explicitDepartments : collectAddressSearchPreferredDepartments(clean)
    )).filter(Boolean);
    if (!preferredDepartments.length && !explicitDepartments.length && hasStreetAndNumber){
      preferredDepartments = ['Las Heras'];
    }
    const requiredDepartments = Array.from(new Set(
      explicitDepartments.length ? explicitDepartments : getDepartmentsForPostalToken(queryPostalCode)
    )).filter(Boolean);
    const enforcePostalStrictly = !explicitDepartments.length;
    const shouldForceDepartmentDiversity = !explicitDepartments.length && hasStreetAndNumber;
    const poolLimit = Math.min(
      20,
      Math.max(maxLimit, shouldForceDepartmentDiversity ? (maxLimit + 6) : maxLimit)
    );
    const pushUnique = (item) => {
      if (!item) return;
      const labelToken = normalizeRegionToken(item.full_text || item.label || '');
      let resolvedPostalCode = normalizePostalCodeToken(item.postal_code || item.postcode || item.zip_code || item.zip || item.full_text || item.label || item.query_hint || '');
      if (!resolvedPostalCode && queryPostalCode) resolvedPostalCode = queryPostalCode;
      let resolvedDepartment = String(
        item.department ||
        findDepartmentInHints([item.query_hint, item.full_text, item.label, item.barrio, clean]) ||
        inferDepartmentFromPostalAndHints(resolvedPostalCode, [item.full_text, item.label, item.barrio, clean]) ||
        ''
      ).trim();
      if (!resolvedDepartment && requiredDepartments.length === 1){
        resolvedDepartment = String(requiredDepartments[0] || '').trim();
      }
      resolvedPostalCode = selectPostalForDepartment(resolvedPostalCode, resolvedDepartment, [
        item.query_hint,
        item.full_text,
        item.label,
        item.barrio,
        clean
      ]);
      const itemPostalDigits = extractNormalizedPostalToken(resolvedPostalCode);
      const itemDepartment = normalizeRegionToken(resolvedDepartment);
      if (enforcePostalStrictly && queryPostalDigits && itemPostalDigits && queryPostalDigits !== itemPostalDigits){
        return;
      }
      if (requiredDepartments.length){
        const hasDepartment = requiredDepartments.some((dep) => {
          const depToken = normalizeRegionToken(dep);
          return depToken && (labelToken.includes(depToken) || itemDepartment === depToken);
        });
        if (!hasDepartment && !(queryPostalDigits && itemPostalDigits && queryPostalDigits === itemPostalDigits)){
          return;
        }
      }
      const preparedItem = normalizeLocationPrefill(Object.assign({}, item, {
        postal_code: resolvedPostalCode,
        department: resolvedDepartment,
        query_hint: clean
      }));
      if (queryNumberHint && /^s\/?n$/i.test(String(preparedItem.numeracion || ''))){
        const itemStreetToken = normalizeRegionToken(preparedItem.calle || '');
        if (queryStreetHintToken && itemStreetToken &&
          (itemStreetToken.includes(queryStreetHintToken) || queryStreetHintToken.includes(itemStreetToken))){
          preparedItem.numeracion = queryNumberHint;
          const streetForText = sanitizeAddressText(preparedItem.calle || '', 80);
          const neighborhoodForText = sanitizeAddressText(preparedItem.barrio || '', 80);
          const departmentForText = sanitizeAddressText(preparedItem.department || '', 80);
          const postalForText = normalizePostalCodeToken(preparedItem.postal_code || '');
          if (!preparedItem.full_text || !hasNormalizedWordToken(preparedItem.full_text, queryNumberHint)){
            preparedItem.full_text = sanitizeAddressLongText(
              [streetForText, preparedItem.numeracion, neighborhoodForText, departmentForText, postalForText]
                .filter(Boolean)
                .join(', '),
              200
            );
          }
          if (!preparedItem.label || /s\/?n/i.test(String(preparedItem.label || ''))){
            preparedItem.label = sanitizeAddressLongText(
              [preparedItem.calle, preparedItem.numeracion, preparedItem.barrio].filter(Boolean).join(', '),
              120
            );
          }
        }
      }
      const key = `${Number(preparedItem.lat).toFixed(6)}|${Number(preparedItem.lon).toFixed(6)}|${normalizeRegionToken(preparedItem.full_text || preparedItem.label || '')}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(preparedItem);
    };
    const arcQueries = [];
    const pushArcQuery = (value) => {
      const normalized = sanitizeAddressLongText(value || '', 120);
      if (!normalized) return;
      if (!arcQueries.includes(normalized)) arcQueries.push(normalized);
    };
    pushArcQuery(clean);
    const titleCase = toAddressTitleCase(clean);
    if (titleCase && titleCase !== clean) pushArcQuery(titleCase);
    if (shouldForceDepartmentDiversity){
      pushArcQuery(`${clean}, Las Heras, Mendoza, Argentina`);
      const streetTitleForLh = toAddressTitleCase(queryStreetInfo.calle || '');
      if (streetTitleForLh){
        const streetWithNumberForLh = [streetTitleForLh, queryNumberHint].filter(Boolean).join(' ').trim();
        if (streetWithNumberForLh) pushArcQuery(`${streetWithNumberForLh}, Las Heras, Mendoza, Argentina`);
      }
    }
    preferredDepartments.forEach((dep) => {
      const depLabel = sanitizeAddressText(dep || '', 80);
      if (!depLabel) return;
      pushArcQuery(`${clean}, ${depLabel}, Mendoza, Argentina`);
      const streetTitle = toAddressTitleCase(queryStreetInfo.calle || '');
      if (streetTitle){
        const streetWithNumber = [streetTitle, queryNumberHint].filter(Boolean).join(' ').trim();
        if (streetWithNumber) pushArcQuery(`${streetWithNumber}, ${depLabel}, Mendoza, Argentina`);
        pushArcQuery(`${streetTitle}, ${depLabel}, Mendoza, Argentina`);
      }
    });
    queries.slice(0, 6).forEach(pushArcQuery);
    for (let idx = 0; idx < arcQueries.length; idx += 1){
      if (requestId !== addressSearchActiveRequestId) return [];
      const q = arcQueries[idx];
      const arcItems = await fetchArcGisAddressSuggestions(q, {
        limit: poolLimit,
        signal: addressSearchAbortController ? addressSearchAbortController.signal : undefined
      });
      arcItems.forEach(pushUnique);
      if (out.length >= poolLimit && idx > 1) break;
    }
    if (out.length < maxLimit || shouldForceDepartmentDiversity){
      const nominatimQueries = [];
      const pushNominatimQuery = (value) => {
        const normalized = sanitizeAddressLongText(value || '', 120);
        if (!normalized) return;
        if (!nominatimQueries.includes(normalized)) nominatimQueries.push(normalized);
      };
      if (shouldForceDepartmentDiversity){
        pushNominatimQuery(`${clean}, Las Heras, Mendoza, Argentina`);
        const streetTitleForLh = toAddressTitleCase(queryStreetInfo.calle || '');
        if (streetTitleForLh){
          const streetWithNumberForLh = [streetTitleForLh, queryNumberHint].filter(Boolean).join(' ').trim();
          if (streetWithNumberForLh) pushNominatimQuery(`${streetWithNumberForLh}, Las Heras, Mendoza, Argentina`);
        }
      }
      preferredDepartments.forEach((dep) => {
        const depLabel = sanitizeAddressText(dep || '', 80);
        if (!depLabel) return;
        pushNominatimQuery(`${clean}, ${depLabel}, Mendoza, Argentina`);
      });
      queries.forEach(pushNominatimQuery);
      for (const q of nominatimQueries){
        if (requestId !== addressSearchActiveRequestId) return [];
        const params = new URLSearchParams({
          format: 'jsonv2',
          addressdetails: '1',
          limit: String(poolLimit),
          countrycodes: 'ar',
          bounded: '1',
          viewbox: `${MENDOZA_BOUNDS.minLon},${MENDOZA_BOUNDS.maxLat},${MENDOZA_BOUNDS.maxLon},${MENDOZA_BOUNDS.minLat}`,
          'accept-language': 'es',
          q
        });
        const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
        const res = await fetch(url, {
          mode: 'cors',
          signal: addressSearchAbortController.signal,
          headers: { 'Accept': 'application/json' }
        });
        if (requestId !== addressSearchActiveRequestId) return [];
        if (!res || !res.ok) continue;
        const data = await res.json().catch(() => []);
        if (!Array.isArray(data) || !data.length) continue;
        data.forEach((item) => {
          const normalized = normalizeAddressSuggestion(item);
          if (!normalized) return;
          if (!isMendozaSuggestion(item, normalized)) return;
          pushUnique(normalized);
        });
        if (out.length >= poolLimit) break;
        if (!shouldForceDepartmentDiversity && out.length >= maxLimit) break;
      }
    }
    const compareByScore = (a, b) => {
      const scoreA = buildSuggestionRankingScore(clean, a);
      const scoreB = buildSuggestionRankingScore(clean, b);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return 0;
    };
    out.sort(compareByScore);
    if (shouldForceDepartmentDiversity){
      const preferredDepartment = preferredDepartments.find((dep) => normalizeDepartmentToken(dep) === 'las heras') ||
        preferredDepartments[0] ||
        '';
      const topResults = out.slice(0, maxLimit);
      const preferredStreetMatch = out.find((item) =>
        suggestionMatchesDepartmentToken(item, preferredDepartment) &&
        suggestionMatchesStreetToken(item, queryStreetHintToken)
      ) || null;
      if (preferredStreetMatch){
        const withoutPreferredFirst = topResults.filter((item) => item !== preferredStreetMatch);
        const reordered = [preferredStreetMatch].concat(withoutPreferredFirst);
        return reordered.slice(0, maxLimit);
      }
      const hasPreferredInTop = topResults.some((item) => suggestionMatchesDepartmentToken(item, preferredDepartment));
      if (!hasPreferredInTop){
        const fallbackMatch = out.slice(maxLimit).find((item) => suggestionMatchesDepartmentToken(item, preferredDepartment));
        if (fallbackMatch){
          if (topResults.length >= maxLimit) topResults[topResults.length - 1] = fallbackMatch;
          else topResults.push(fallbackMatch);
          topResults.sort(compareByScore);
          return topResults.slice(0, maxLimit);
        }
      }
      return topResults;
    }
    return out.slice(0, maxLimit);
  }catch(_){
    return [];
  }
}

function showAddressSearchModal({
  title = 'Ingresa tu dirección',
  subtitle = 'Escribe una dirección o punto de referencia en Mendoza.',
  initialQuery = ''
} = {}){
  return new Promise((resolve) => {
    try{
      ensureGlobalDialogStyles();
      const overlay = document.createElement('div');
      overlay.className = '__dialog_overlay __addr_search_overlay';
      overlay.style.zIndex = 3400;
      overlay.innerHTML = `
        <div class="__dialog __dialog--info __addr_search_dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="__addr_search_head">
            <button type="button" class="btn btn-ghost __addr_search_back" data-action="cancel" aria-label="Volver">←</button>
            <div>
              <h3>${escapeHtml(title)}</h3>
              <p>${escapeHtml(subtitle)}</p>
            </div>
          </div>
          <div class="__addr_search_box">
            <input id="__addr_search_input" class="__addr_search_input" type="text" placeholder="Dirección o punto de referencia" />
            <button type="button" class="btn btn-ghost __addr_search_geo" data-action="use_current">Mi ubicación actual</button>
          </div>
          <div id="__addr_search_status" class="__addr_search_status">Escribí al menos 3 caracteres para buscar en Mendoza.</div>
          <div class="__addr_search_manual_wrap">
            <button type="button" class="btn btn-ghost __addr_search_manual" data-action="manual_map">No aparece mi dirección, ubicar en mapa</button>
          </div>
          <div id="__addr_search_list" class="__addr_search_list"></div>
        </div>
      `;
      document.body.appendChild(overlay);
      const dialog = overlay.querySelector('.__dialog');
      const input = overlay.querySelector('#__addr_search_input');
      const listEl = overlay.querySelector('#__addr_search_list');
      const statusEl = overlay.querySelector('#__addr_search_status');
      const currentBtn = overlay.querySelector('[data-action="use_current"]');
      const manualMapBtn = overlay.querySelector('[data-action="manual_map"]');
      let closed = false;
      let optionsCache = [];

      const cleanup = () => {
        if (closed) return;
        closed = true;
        try{
          if (addressSearchTimer) clearTimeout(addressSearchTimer);
          addressSearchTimer = null;
          if (addressSearchAbortController) addressSearchAbortController.abort();
        }catch(_){ }
        try{ overlay.remove(); window.removeEventListener('keydown', onKey); }catch(_){ }
      };
      const closeWith = (value) => { cleanup(); resolve(value || null); };
      const onKey = (ev) => {
        if (ev.key === 'Escape' && isTopDialogOverlay(overlay)) closeWith(null);
        if (ev.key === 'Enter'){
          if (ev.shiftKey){
            const typed = sanitizeAddressLongText(input && input.value ? input.value : '', 120);
            closeWith({ __manual_map: true, query: typed });
            return;
          }
          const first = optionsCache[0];
          if (first){
            const typed = sanitizeAddressLongText(input && input.value ? input.value : '', 120);
            closeWith(Object.assign({}, first, { query_hint: typed }));
          }
        }
      };
      window.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay && isTopDialogOverlay(overlay)) closeWith(null);
      });

      overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeWith(null));
      manualMapBtn?.addEventListener('click', () => {
        const typed = sanitizeAddressLongText(input && input.value ? input.value : '', 120);
        closeWith({ __manual_map: true, query: typed });
      });
      currentBtn?.addEventListener('click', async () => {
        if (currentBtn) currentBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Buscando tu ubicación actual...';
        const current = await getCurrentLocationPrefill();
        if (!current){
          if (statusEl) statusEl.textContent = 'No pudimos obtener tu ubicación actual.';
          if (currentBtn) currentBtn.disabled = false;
          return;
        }
        if (!isMendozaPrefill(current)){
          if (statusEl) statusEl.textContent = 'Tu ubicación actual está fuera de Mendoza.';
          if (currentBtn) currentBtn.disabled = false;
          return;
        }
        closeWith(current);
      });

      const renderList = (items) => {
        optionsCache = Array.isArray(items) ? items : [];
        if (!listEl) return;
        if (!optionsCache.length){
          listEl.innerHTML = '';
          return;
        }
        listEl.innerHTML = optionsCache.map((option, idx) => `
          <button type="button" class="__addr_search_item" data-index="${idx}">
            <span class="__addr_search_pin" aria-hidden="true">📍</span>
            <span class="__addr_search_text">${escapeHtml(buildCompactLocationLabel(option, 4) || 'Ubicación')}</span>
          </button>
        `).join('');
      };

      listEl?.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-index]');
        if (!btn) return;
        const idx = Number(btn.getAttribute('data-index'));
        if (!Number.isFinite(idx) || !optionsCache[idx]) return;
        const typed = sanitizeAddressLongText(input && input.value ? input.value : '', 120);
        closeWith(Object.assign({}, optionsCache[idx], { query_hint: typed }));
      });

      const executeSearch = async (query) => {
        const q = sanitizeAddressLongText(query || '', 120);
        if (q.length < 3){
          renderList([]);
          if (statusEl) statusEl.textContent = 'Escribí al menos 3 caracteres para buscar en Mendoza.';
          return;
        }
        if (statusEl) statusEl.textContent = 'Buscando direcciones en Mendoza...';
        let result = await fetchAddressSuggestions(q, { limit: 7 });
        if (!result.length){
          const titleCase = toAddressTitleCase(q);
          if (titleCase && titleCase !== q){
            result = await fetchAddressSuggestions(titleCase, { limit: 7 });
          }
        }
        const accountId = getCurrentAccountStorageId();
        const localMatches = getSavedAddressSuggestionMatches(q, { limit: 4, accountId });
        const merged = [];
        const seen = new Set();
        const pushUnique = (item) => {
          if (!item) return;
          const key = `${normalizeRegionToken(item.full_text || item.label || '')}|${Number(item.lat || 0).toFixed(6)}|${Number(item.lon || 0).toFixed(6)}`;
          if (seen.has(key)) return;
          seen.add(key);
          merged.push(item);
        };
        localMatches.forEach(pushUnique);
        (result || []).forEach(pushUnique);
        const finalResult = merged.slice(0, 7);
        if (finalResult.length){
          renderList(finalResult);
          if (statusEl) statusEl.textContent = 'Selecciona una dirección para continuar.';
        } else {
          renderList([]);
          if (statusEl) statusEl.textContent = 'No encontramos coincidencias en Mendoza. Probá con más detalle.';
        }
      };

      input?.addEventListener('input', () => {
        const q = String(input.value || '');
        if (addressSearchTimer) clearTimeout(addressSearchTimer);
        addressSearchTimer = setTimeout(() => { executeSearch(q); }, 220);
      });

      requestAnimationFrame(() => {
        try{
          overlay.classList.add('open');
          if (dialog) dialog.classList.add('open');
        }catch(_){ }
      });

      setTimeout(() => {
        try{
          if (input){
            input.value = String(initialQuery || '').trim();
            input.focus();
            const value = input.value || '';
            if (value.length >= 3) executeSearch(value);
          }
        }catch(_){ }
      }, 40);
    }catch(e){
      console.error('showAddressSearchModal failed', e);
      resolve(null);
    }
  });
}

function showAddressMapConfirmModal(prefill, { title = 'Confirma tu dirección' } = {}){
  return new Promise((resolve) => {
    try{
      const initial = normalizeAddressSuggestion(prefill) || normalizeLocationPrefill(prefill || {});
      const latLon = getAuthLocationLatLon(initial);
      if (!latLon){
        resolve(null);
        return;
      }
      ensureGlobalDialogStyles();
      const overlay = document.createElement('div');
      overlay.className = '__dialog_overlay __addr_map_overlay';
      overlay.style.zIndex = 3410;
      overlay.innerHTML = `
        <div class="__dialog __dialog--info __addr_map_dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <div class="__addr_map_head">
            <h3>${escapeHtml(title)}</h3>
            <button type="button" class="btn btn-ghost" data-action="use_current">Usar mi ubicación</button>
          </div>
          <div id="__addr_map_canvas" class="__addr_map_canvas" aria-label="Mapa para confirmar ubicación"></div>
          <div class="__addr_map_help">Podés mover el pin para ajustar la ubicación exacta.</div>
          <div id="__addr_map_precision" class="__addr_map_precision"></div>
          <div class="__addr_map_address_wrap">
            <input id="__addr_map_address" class="__addr_map_address" type="text" readonly />
          </div>
          <div class="actions">
            <button class="btn btn-ghost" data-action="cancel">Cancelar</button>
            <button class="btn btn-primary" data-action="confirm">Confirmar ubicación</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const dialog = overlay.querySelector('.__dialog');
      const mapCanvas = overlay.querySelector('#__addr_map_canvas');
      const addressInput = overlay.querySelector('#__addr_map_address');
      const precisionHintEl = overlay.querySelector('#__addr_map_precision');
      const useCurrentBtn = overlay.querySelector('[data-action="use_current"]');
      let currentPrefill = normalizeLocationPrefill(initial);
      let currentIsMendoza = isMendozaPrefill(currentPrefill);
      let reverseRequestId = 0;

      const setAddressLabel = (data) => {
        const value = buildCompactLocationLabel(data, 4) || [data?.calle, data?.numeracion, data?.barrio].filter(Boolean).join(', ');
        if (addressInput) addressInput.value = (value || 'Ubicación seleccionada') + (currentIsMendoza ? '' : ' (Fuera de Mendoza)');
      };
      const setPrecisionHint = (data) => {
        if (!precisionHintEl) return;
        const needsAdjust = !!(data && data.requires_pin_adjustment);
        if (!needsAdjust){
          precisionHintEl.classList.remove('show');
          precisionHintEl.textContent = '';
          return;
        }
        precisionHintEl.classList.add('show');
        precisionHintEl.textContent = 'Ubicación aproximada para esa numeración. Mueve el pin hasta la puerta exacta antes de confirmar.';
      };
      setAddressLabel(currentPrefill);
      setPrecisionHint(currentPrefill);

      const cleanupMap = () => {
        try{
          if (addressPickerMapInstance){
            addressPickerMapInstance.remove();
          }
        }catch(_){ }
        addressPickerMapInstance = null;
        addressPickerMapMarker = null;
      };
      const cleanup = () => {
        try{ cleanupMap(); }catch(_){ }
        try{ overlay.remove(); window.removeEventListener('keydown', onKey); }catch(_){ }
      };
      const closeWith = (value) => {
        cleanup();
        resolve(value || null);
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape' && isTopDialogOverlay(overlay)) closeWith(null);
      };
      window.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay && isTopDialogOverlay(overlay)) closeWith(null);
      });

      const applyFromMapPoint = async (lat, lon) => {
        try{
          const requestId = ++reverseRequestId;
          const previousPostal = normalizePostalCodeToken(currentPrefill?.postal_code || currentPrefill?.query_hint || '');
          const previousDepartment = sanitizeAddressText(
            currentPrefill?.department ||
            findDepartmentInHints([currentPrefill?.query_hint, currentPrefill?.full_text, currentPrefill?.barrio]) ||
            inferDepartmentFromPostalAndHints(previousPostal, [currentPrefill?.barrio, currentPrefill?.full_text, currentPrefill?.query_hint]) ||
            '',
            80
          );
          const previousQueryHint = sanitizeAddressLongText(currentPrefill?.query_hint || '', 120);
          const reverse = await reverseGeocodeLocation(lat, lon);
          if (requestId !== reverseRequestId) return;
          currentPrefill = reverse
            ? normalizeLocationPrefill(Object.assign({}, currentPrefill || {}, reverse, { lat, lon, ts: Date.now() }))
            : normalizeLocationPrefill(Object.assign({}, currentPrefill || {}, { lat, lon, ts: Date.now() }));
          if (!currentPrefill.query_hint && previousQueryHint) currentPrefill.query_hint = previousQueryHint;
          const resolvedDepartment = sanitizeAddressText(
            currentPrefill.department ||
            previousDepartment ||
            findDepartmentInHints([currentPrefill.query_hint, currentPrefill.full_text, currentPrefill.barrio, previousQueryHint]) ||
            inferDepartmentFromPostalAndHints(currentPrefill.postal_code, [currentPrefill.barrio, currentPrefill.full_text, previousQueryHint]) ||
            '',
            80
          );
          const resolvedPostal = selectPostalForDepartment(currentPrefill.postal_code, resolvedDepartment, [
            currentPrefill.query_hint,
            currentPrefill.full_text,
            currentPrefill.barrio,
            previousQueryHint
          ]);
          const previousPostalSafe = selectPostalForDepartment(previousPostal, resolvedDepartment || previousDepartment, [
            previousQueryHint,
            currentPrefill.full_text,
            currentPrefill.barrio
          ]);
          currentPrefill.department = resolvedDepartment;
          currentPrefill.postal_code = resolvedPostal || previousPostalSafe || '';
          if (!currentPrefill.numeracion) currentPrefill.numeracion = 'S/N';
          currentPrefill.requires_pin_adjustment = false;
          currentPrefill.precision_level = 'exact';
          currentIsMendoza = isMendozaPrefill(currentPrefill);
          setAddressLabel(currentPrefill);
          setPrecisionHint(currentPrefill);
        }catch(_){ }
      };

      if (hasLeafletForAuthLocation() && mapCanvas){
        const L = window.L;
        addressPickerMapInstance = L.map(mapCanvas, {
          zoomControl: true,
          attributionControl: true,
          scrollWheelZoom: true,
          preferCanvas: true
        });
        const baseLayer = createLeafletBaseLayer();
        if (baseLayer) baseLayer.addTo(addressPickerMapInstance);
        addressPickerMapMarker = L.marker([latLon.lat, latLon.lon], {
          draggable: true,
          icon: createLeafletPinIcon('__map_pin __map_pin--picker') || undefined
        }).addTo(addressPickerMapInstance);
        addressPickerMapMarker.on('dragend', async () => {
          try{
            const point = addressPickerMapMarker.getLatLng();
            await applyFromMapPoint(point.lat, point.lng);
          }catch(_){ }
        });
        addressPickerMapInstance.on('click', async (ev) => {
          try{
            const point = ev && ev.latlng ? ev.latlng : null;
            if (!point) return;
            if (addressPickerMapMarker) addressPickerMapMarker.setLatLng(point);
            await applyFromMapPoint(point.lat, point.lng);
          }catch(_){ }
        });
        addressPickerMapInstance.setView([latLon.lat, latLon.lon], 17, { animate: false });
        setTimeout(() => {
          try{ addressPickerMapInstance.invalidateSize(); }catch(_){ }
        }, 60);
      } else if (mapCanvas){
        mapCanvas.innerHTML = `
          <iframe
            title="Mapa de dirección"
            loading="lazy"
            referrerpolicy="no-referrer-when-downgrade"
            src="${escapeHtml(buildAuthLocationMapUrl(latLon.lat, latLon.lon))}"
          ></iframe>
        `;
      }

      useCurrentBtn?.addEventListener('click', async () => {
        if (useCurrentBtn) useCurrentBtn.disabled = true;
        const loc = await getCurrentLocationPrefill();
        if (!loc){
          if (useCurrentBtn) useCurrentBtn.disabled = false;
          try{ showAlert('No pudimos obtener tu ubicación actual.', 'warning'); }catch(_){ }
          return;
        }
        const point = getAuthLocationLatLon(loc);
        currentPrefill = loc;
        currentPrefill.requires_pin_adjustment = false;
        currentPrefill.precision_level = 'exact';
        currentIsMendoza = isMendozaPrefill(currentPrefill);
        setAddressLabel(currentPrefill);
        setPrecisionHint(currentPrefill);
        if (point && addressPickerMapMarker && addressPickerMapInstance){
          addressPickerMapMarker.setLatLng([point.lat, point.lon]);
          addressPickerMapInstance.setView([point.lat, point.lon], 17, { animate: true });
        }
        if (useCurrentBtn) useCurrentBtn.disabled = false;
      });

      overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeWith(null));
      overlay.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        if (!currentIsMendoza){
          try{ showAlert('Solo se permiten direcciones de Mendoza.', 'warning'); }catch(_){ }
          return;
        }
        if (currentPrefill && currentPrefill.requires_pin_adjustment){
          try{ showAlert('La ubicación es aproximada. Ajusta el pin sobre la puerta exacta para continuar.', 'warning'); }catch(_){ }
          return;
        }
        if (!currentPrefill.numeracion) currentPrefill.numeracion = 'S/N';
        const asAddress = locationPrefillToAddress(currentPrefill, { label: '' });
        if (!asAddress){
          try{ showAlert('No pudimos validar la dirección. Ajustá el pin e intenta de nuevo.'); }catch(_){ }
          return;
        }
        closeWith(Object.assign({}, currentPrefill, asAddress));
      });

      requestAnimationFrame(() => {
        try{
          overlay.classList.add('open');
          if (dialog) dialog.classList.add('open');
        }catch(_){ }
      });
    }catch(e){
      console.error('showAddressMapConfirmModal failed', e);
      resolve(null);
    }
  });
}

async function pickAddressWithSearchAndMap({
  title = 'Ingresa tu dirección',
  subtitle = 'Escribe una dirección o punto de referencia en Mendoza.',
  initialQuery = ''
} = {}){
  const picked = await showAddressSearchModal({ title, subtitle, initialQuery });
  if (!picked) return null;
  const wantsManualMap = !!(picked && picked.__manual_map);
  let mapSeed = wantsManualMap ? getManualMapSeedPrefill(picked.query || initialQuery || '') : picked;
  if (!wantsManualMap){
    mapSeed = await resolveAddressSeedForMap(mapSeed, picked.query_hint || initialQuery || '');
  }
  const confirmed = await showAddressMapConfirmModal(mapSeed, { title: 'Confirma tu dirección' });
  if (!confirmed) return null;
  const payload = locationPrefillToAddress(confirmed, { label: '' });
  if (!payload){
    try{ await showAlert('No pudimos guardar esa ubicación. Intenta con otra dirección.', 'warning'); }catch(_){ }
    return null;
  }
  if (!isMendozaPrefill(payload)){
    try{ await showAlert('Solo se permiten direcciones de Mendoza.', 'warning'); }catch(_){ }
    return null;
  }
  return payload;
}

async function requestAuthLocation(options = {}){
  const auto = !!options?.auto;
  if (authLocationRequestInFlight) return;
  if (!navigator.geolocation){
    updateAuthLocationCard(authLocationPrefill, 'Tu navegador no soporta geolocalización.');
    return;
  }
  authLocationRequestInFlight = true;
  setAuthLocationLoading(true);
  setAuthLocationStatus('Esperando permiso para acceder a tu ubicación...');
  navigator.geolocation.getCurrentPosition(async (position) => {
    try{
      const lat = Number(position?.coords?.latitude);
      const lon = Number(position?.coords?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('invalid-coordinates');
      let prefill = normalizeLocationPrefill({ lat, lon, ts: Date.now() });
      try{
        const reverse = await reverseGeocodeLocation(lat, lon);
        if (reverse) prefill = reverse;
      }catch(_){ }
      authLocationPrefill = prefill;
      saveLocationPrefillCache(prefill);
      if (prefill.barrio || prefill.calle || prefill.numeracion){
        saveDeliveryAddressCache(prefill);
      }
      applyLocationToRegisterFields(prefill, { onlyEmpty: true });
      updateAuthLocationCard(prefill, auto ? 'Ubicación detectada. Revisá y continuá.' : 'Ubicación actualizada.');
    }catch(_){
      updateAuthLocationCard(authLocationPrefill, 'No pudimos obtener tu ubicación. Cargá tu dirección manualmente.');
    }finally{
      authLocationRequestInFlight = false;
      setAuthLocationLoading(false);
    }
  }, (error) => {
    let msg = 'No pudimos obtener tu ubicación. Cargá tu dirección manualmente.';
    if (error && error.code === 1) msg = 'No diste permiso de ubicación. Podés continuar cargando tu dirección manualmente.';
    else if (error && error.code === 2) msg = 'No se pudo detectar tu ubicación actual.';
    else if (error && error.code === 3) msg = 'La solicitud de ubicación tardó demasiado.';
    updateAuthLocationCard(authLocationPrefill, msg);
    authLocationRequestInFlight = false;
    setAuthLocationLoading(false);
  }, {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 0,
  });
}

function initAuthLocationCard(){
  const card = document.getElementById('authLocationCard');
  if (!card) return;
  const useBtn = document.getElementById('authUseLocationBtn');
  const applyBtn = document.getElementById('authApplyLocationBtn');
  if (useBtn && !useBtn.dataset.bound){
    useBtn.dataset.bound = '1';
    useBtn.addEventListener('click', () => { requestAuthLocation({ auto: false }); });
  }
  if (applyBtn && !applyBtn.dataset.bound){
    applyBtn.dataset.bound = '1';
    applyBtn.addEventListener('click', () => {
      const current = authLocationPrefill || loadLocationPrefillCache();
      if (!current) return;
      applyLocationToRegisterFields(current, { onlyEmpty: false });
      saveDeliveryAddressCache(current);
      const tabRegister = document.getElementById('tabRegister');
      if (tabRegister) tabRegister.click();
      updateAuthLocationCard(current, 'Ubicación aplicada al registro.');
      try{ showToast('Ubicación aplicada al registro', 2600); }catch(_){ }
    });
  }
  authLocationPrefill = authLocationPrefill || loadLocationPrefillCache();
  updateAuthLocationCard(authLocationPrefill, authLocationPrefill ? 'Ubicación guardada lista para usar.' : '');
}

function showDeliveryAddressModal(prefill = {}){
  return new Promise((resolve)=>{
    try{
      ensureGlobalDialogStyles();
      const token = getToken();
      const accountId = getCurrentAccountStorageId();
      seedAddressBookFromKnownLocations(accountId);
      const cached = loadDeliveryAddressCache() || {};
      const defaultAddress = getDefaultAddressFromBook(accountId) || {};
      const addressBook = loadAddressBook(accountId);
      const savedAddresses = Array.isArray(addressBook.addresses) ? [...addressBook.addresses]
        .filter((addr) => isMendozaPrefill(addr))
        .sort((a, b) => {
        if (a.id === addressBook.defaultId) return -1;
        if (b.id === addressBook.defaultId) return 1;
        return Number(b.created_at || 0) - Number(a.created_at || 0);
      }) : [];
      const initialNotes = sanitizeDeliveryNotes(prefill?.instrucciones || prefill?.instructions || prefill?.delivery_notes || cached.instrucciones || '');
      const initialAlias = sanitizeAddressAlias(prefill?.label || defaultAddress.label || cached.label || '');
      const overlay = document.createElement('div');
      overlay.className = '__dialog_overlay';
      overlay.style.zIndex = 3360;
      overlay.innerHTML = `
        <div class="__dialog __dialog--info __delivery_dialog" role="dialog" aria-modal="true" aria-label="Dirección de entrega">
          <div class="dialog-header"><span class="dialog-icon">📍</span><h3>Dirección de entrega</h3></div>
          <div class="dialog-body">
            <p class="__delivery_hint">Confirma dónde entregamos este pedido.</p>
            <div class="__addr_saved_block">
              <div class="__addr_saved_title">Direcciones guardadas</div>
              ${savedAddresses.length ? '<div class="__addr_saved_list"></div>' : `<p class="__addr_saved_empty">${token ? 'Aún no guardaste direcciones en tu cuenta.' : 'Aún no guardaste direcciones en este dispositivo.'}</p>`}
            </div>
            <div class="__delivery_inputs">
              <div class="__delivery_selected_card">
                <div class="__delivery_selected_title">Dirección seleccionada</div>
                <div id="__delivery_selected_line" class="__delivery_selected_line">Sin dirección seleccionada.</div>
              </div>
              <label for="__addr_alias" class="__delivery_alias_label">Nombre de la dirección (opcional)</label>
              <input id="__addr_alias" class="__delivery_alias_input" type="text" placeholder="Ej: Casa, Trabajo" />
              <button id="__addr_add_new" type="button" class="btn btn-primary __delivery_add_btn">Añadir nueva ubicación</button>
              <label for="__addr_notes" class="__addr_notes_label">Instrucciones de entrega (opcional)</label>
              <textarea id="__addr_notes" placeholder="Ej: dejar en portería, tocar timbre 2, entregar a nombre de..."></textarea>
              <small class="__addr_notes_hint">Estas indicaciones se guardan para este pedido y se incluyen en el resumen.</small>
            </div>
            <label class="__addr_check"><input id="__addr_save_book" type="checkbox" ${token ? 'checked' : ''}>Guardar esta dirección en ${token ? 'Mi cuenta' : 'este dispositivo'}</label>
            <label class="__addr_check"><input id="__addr_set_default" type="checkbox" ${savedAddresses.length ? '' : 'checked'}>Usar como dirección predeterminada</label>
          </div>
          <div class="actions">
            ${token ? '<button class="btn btn-ghost" data-action="manage">Mi cuenta</button>' : ''}
            <button class="btn btn-ghost" data-action="cancel">Cancelar</button>
            <button class="btn btn-primary" data-action="save">Continuar</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const dialog = overlay.querySelector('.__dialog');
      let selectedAddressId = addressBook.defaultId || null;
      let selectedAddress = null;
      const initialFromManual = locationPrefillToAddress({
        barrio: prefill?.barrio || defaultAddress.barrio || cached.barrio || '',
        calle: prefill?.calle || defaultAddress.calle || cached.calle || '',
        numeracion: prefill?.numeracion || prefill?.numero || defaultAddress.numeracion || cached.numeracion || '',
        postal_code: prefill?.postal_code || defaultAddress.postal_code || cached.postal_code || '',
        department: prefill?.department || defaultAddress.department || cached.department || '',
        label: prefill?.label || defaultAddress.label || '',
        full_text: prefill?.full_text || cached.full_text || '',
        lat: prefill?.lat || cached.lat || null,
        lon: prefill?.lon || cached.lon || null
      }, { label: initialAlias });
      if (selectedAddressId){
        selectedAddress = savedAddresses.find(a => String(a.id) === String(selectedAddressId)) || null;
      }
      if (!selectedAddress && initialFromManual && isMendozaPrefill(initialFromManual)) selectedAddress = initialFromManual;

      const selectedLine = overlay.querySelector('#__delivery_selected_line');
      const aliasInput = overlay.querySelector('#__addr_alias');
      const notesInput = overlay.querySelector('#__addr_notes');
      const savedList = overlay.querySelector('.__addr_saved_list');
      const renderSelectedAddress = () => {
        if (!selectedLine) return;
        if (!selectedAddress){
          selectedLine.textContent = 'Sin dirección seleccionada.';
          selectedLine.classList.add('__delivery_selected_empty');
          if (aliasInput) aliasInput.value = '';
          return;
        }
        selectedLine.classList.remove('__delivery_selected_empty');
        const alias = sanitizeAddressAlias(selectedAddress.label || '');
        const display = buildAddressDisplay(selectedAddress);
        selectedLine.textContent = alias ? (alias + ' · ' + display) : display;
        if (aliasInput) aliasInput.value = alias || '';
      };
      const renderSavedChips = () => {
        if (!savedList) return;
        savedList.innerHTML = savedAddresses.map((addr) => {
          const isDefault = String(addr.id) === String(addressBook.defaultId || '');
          const active = String(addr.id) === String(selectedAddressId || '');
          const name = addr.label || buildAddressDisplay(addr);
          return `<button type="button" class="__addr_saved_chip ${active ? 'active' : ''}" data-address-id="${escapeHtml(String(addr.id))}" title="${escapeHtml(buildAddressDisplay(addr))}">${escapeHtml(name)}${isDefault ? ' • Predeterminada' : ''}</button>`;
        }).join('');
      };
      requestAnimationFrame(()=>{
        try{
          overlay.classList.add('open');
          if (dialog) dialog.classList.add('open');
        }catch(_){ }
      });
      renderSavedChips();
      renderSelectedAddress();
      try{
        const notesFromSelected = selectedAddress ? sanitizeDeliveryNotes(selectedAddress.notes || '') : '';
        if (notesInput) notesInput.value = notesFromSelected || initialNotes;
        if (aliasInput && !aliasInput.value) aliasInput.value = initialAlias || '';
      }catch(_){ }

      savedList?.addEventListener('click', (ev) => {
        const chip = ev.target.closest('button[data-address-id]');
        if (!chip) return;
        const id = String(chip.getAttribute('data-address-id') || '').trim();
        const selected = savedAddresses.find(a => String(a.id) === id);
        if (!selected) return;
        selectedAddressId = id;
        selectedAddress = selected;
        renderSavedChips();
        renderSelectedAddress();
        if (notesInput){
          const selectedNotes = sanitizeDeliveryNotes(selected && selected.notes ? selected.notes : '');
          notesInput.value = selectedNotes || '';
        }
      });

      const cleanup = ()=>{ try{ overlay.remove(); window.removeEventListener('keydown', onKey); }catch(_){ } };
      const closeWith = (value)=>{ cleanup(); resolve(value); };
      const onKey = (ev)=>{ if (ev.key === 'Escape' && isTopDialogOverlay(overlay)) closeWith(null); };
      window.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (ev)=>{ if (ev.target === overlay && isTopDialogOverlay(overlay)) closeWith(null); });

      const cancelBtn = overlay.querySelector('[data-action="cancel"]');
      const saveBtn = overlay.querySelector('[data-action="save"]');
      const manageBtn = overlay.querySelector('[data-action="manage"]');
      const addLocationBtn = overlay.querySelector('#__addr_add_new');
      if (cancelBtn) cancelBtn.addEventListener('click', ()=> closeWith(null));
      if (manageBtn) manageBtn.addEventListener('click', ()=>{
        try{ openAccountModal(); }catch(_){ }
      });
      if (addLocationBtn) addLocationBtn.addEventListener('click', async ()=>{
        addLocationBtn.disabled = true;
        try{
          const searchQuery = selectedAddress ? buildAddressDisplay(selectedAddress) : '';
          const added = await pickAddressWithSearchAndMap({
            title: 'Ingresa tu dirección',
            subtitle: 'Busca tu dirección y luego confirmala en el mapa.',
            initialQuery: searchQuery
          });
          if (!added) return;
          selectedAddress = added;
          const same = savedAddresses.find(a =>
            String(a.barrio || '').toLowerCase() === String(added.barrio || '').toLowerCase() &&
            String(a.calle || '').toLowerCase() === String(added.calle || '').toLowerCase() &&
            String(a.numeracion || '').toLowerCase() === String(added.numeracion || '').toLowerCase()
          );
          selectedAddressId = same ? same.id : null;
          renderSavedChips();
          renderSelectedAddress();
        }finally{
          addLocationBtn.disabled = false;
        }
      });
      if (saveBtn) saveBtn.addEventListener('click', ()=>{
        const saveToggle = document.getElementById('__addr_save_book');
        const defaultToggle = document.getElementById('__addr_set_default');
        const notes = sanitizeDeliveryNotes(notesInput && notesInput.value ? notesInput.value : '');
        const alias = sanitizeAddressAlias(aliasInput && aliasInput.value ? aliasInput.value : (selectedAddress && selectedAddress.label ? selectedAddress.label : ''));
        if (!selectedAddress){
          try{ showAlert('Selecciona una dirección para continuar.'); }catch(_){ }
          return;
        }
        const cleanSelected = locationPrefillToAddress(selectedAddress, { label: selectedAddress.label || '' });
        if (!cleanSelected){
          try{ showAlert('La dirección seleccionada no es válida.'); }catch(_){ }
          return;
        }
        if (!isMendozaPrefill(cleanSelected)){
          try{ showAlert('Solo se permiten direcciones de Mendoza.', 'warning'); }catch(_){ }
          return;
        }
        const shouldPersist = token || (saveToggle && saveToggle.checked);
        const out = Object.assign({}, cleanSelected, { label: alias, instrucciones: notes, notes });
        saveDeliveryAddressCache(out);
        if (shouldPersist){
          const bookNow = loadAddressBook(accountId);
          const persisted = upsertAddressInBook({
            id: selectedAddressId || undefined,
            label: alias,
            notes,
            barrio: out.barrio,
            calle: out.calle,
            numeracion: out.numeracion,
            postal_code: out.postal_code,
            department: out.department,
            query_hint: out.query_hint,
            full_text: out.full_text,
            lat: out.lat,
            lon: out.lon
          }, {
            accountId,
            setDefault: Boolean(defaultToggle && defaultToggle.checked) || !bookNow.defaultId
          });
          if (persisted && persisted.id) selectedAddressId = persisted.id;
        }
        if (selectedAddressId) {
          setLastUsedAddressId(selectedAddressId, accountId);
        }
        closeWith(out);
      });

      setTimeout(()=>{
        try{
          if (!selectedAddress) document.getElementById('__addr_add_new')?.focus();
          else (aliasInput || notesInput)?.focus();
        }catch(_){ }
      }, 50);
    }catch(e){ console.error('showDeliveryAddressModal failed', e); resolve(null); }
  });
}
async function fetchCurrentProfileSafe(){
  try{
    const token = getToken();
    if (!token) return null;
    const res = await fetchWithTimeout(`${API_ORIGIN}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
      mode: 'cors'
    }, 9000);
    if (!res || !res.ok) return null;
    return await res.json();
  }catch(_){ return null; }
}
function openAccountModal(){
  const token = getToken();
  if (!token) { openAuthModal(); return; }
  try{
    ensureGlobalDialogStyles();
    const existing = document.getElementById('__account_overlay');
    if (existing){
      const d = existing.querySelector('.__dialog');
      existing.classList.add('open');
      if (d) d.classList.add('open');
      return;
    }

    const payload = parseJwt(token) || {};
    const fallbackEmail = String(payload.sub || payload.email || '').trim();
    const fallbackName = String(payload.full_name || payload.name || '').trim();
    const accountId = getCurrentAccountStorageId();
    try{
      seedAddressBookFromKnownLocations(accountId);
    }catch(_){ }

    const overlay = document.createElement('div');
    overlay.className = '__dialog_overlay';
    overlay.id = '__account_overlay';
    overlay.style.zIndex = 3380;
    overlay.innerHTML = `
      <div class="__dialog __dialog--info __account_dialog" role="dialog" aria-modal="true" aria-label="Mi cuenta">
        <div class="dialog-header">
          <span class="dialog-icon">👤</span>
          <h3>Mi cuenta</h3>
          <div class="__account_header_actions" style="margin-left:auto">
            <button class="btn btn-ghost" data-action="close_top">Cerrar</button>
          </div>
        </div>
        <div class="dialog-body">
          <div class="__account_identity">
            <div class="__account_identity_main">
              <span class="__account_identity_avatar" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" role="presentation">
                  <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8"></circle>
                  <path d="M4 20c1.6-3.6 4.7-5.4 8-5.4s6.4 1.8 8 5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
                </svg>
              </span>
              <div>
                <div class="__account_name" id="__acc_name">${escapeHtml(fallbackName || 'Cuenta activa')}</div>
                <div class="__account_email" id="__acc_email">${escapeHtml(fallbackEmail || '')}</div>
              </div>
            </div>
            <div class="__account_subtle">Las direcciones se guardan en este navegador.</div>
          </div>
          <div class="__account_layout">
            <section class="__account_panel">
              <h4>Direcciones guardadas</h4>
              <div id="__account_address_list" class="__account_address_list"></div>
            </section>
            <section class="__account_panel">
              <h4>Añadir ubicación</h4>
              <div class="__account_form">
                <div class="__account_subtle">Buscá una dirección y confirmala en el mapa antes de guardar.</div>
                <button class="btn btn-primary" data-action="add_address">Añadir nueva ubicación</button>
              </div>
            </section>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost" data-action="my_orders_bottom">Mis pedidos</button>
          <button class="btn btn-ghost" data-action="logout">Cerrar sesión</button>
          <button class="btn btn-primary" data-action="close_bottom">Listo</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const dialog = overlay.querySelector('.__dialog');
    requestAnimationFrame(()=>{
      try{
        overlay.classList.add('open');
        if (dialog) dialog.classList.add('open');
      }catch(_){ }
    });

    const listEl = overlay.querySelector('#__account_address_list');
    const addAddressBtn = overlay.querySelector('[data-action="add_address"]');

    function closeModal(){
      try{ overlay.remove(); window.removeEventListener('keydown', onKey); }catch(_){ }
    }
    function renderList(){
      const book = loadAddressBook(accountId);
      const lastUsedId = getLastUsedAddressId(accountId);
      const list = Array.isArray(book.addresses) ? [...book.addresses]
        .filter((addr) => isMendozaPrefill(addr))
        .sort((a, b) => {
        if (String(a.id) === String(book.defaultId)) return -1;
        if (String(b.id) === String(book.defaultId)) return 1;
        return Number(b.created_at || 0) - Number(a.created_at || 0);
      }) : [];
      if (!listEl) return;
      if (!list.length){
        listEl.innerHTML = '<div class="__account_empty">No tenés direcciones guardadas todavía.</div>';
        return;
      }
      listEl.innerHTML = list.map((addr) => {
        const label = addr.label || 'Dirección';
        const isDefault = String(addr.id) === String(book.defaultId || '');
        const isLastUsed = String(addr.id) === String(lastUsedId || '');
        const notes = sanitizeDeliveryNotes(addr.notes || '');
        return `
          <div class="__account_addr_item ${isDefault ? 'is-default' : ''}">
            <div class="__account_addr_top">
              <div class="__account_addr_label __account_addr_name">
                <span>${escapeHtml(label)}</span>
                ${isLastUsed ? '<span class="__account_addr_last">(última usada)</span>' : ''}
              </div>
              ${isDefault ? '<span class="__account_addr_badge">Predeterminada</span>' : ''}
            </div>
            <div class="__account_addr_line">${escapeHtml(buildAddressDisplay(addr))}</div>
            ${notes ? `<div class="__account_addr_notes">Notas: ${escapeHtml(notes)}</div>` : ''}
            <div class="__account_addr_actions">
              <button class="btn btn-ghost" data-action="use" data-id="${escapeHtml(String(addr.id))}">Usar</button>
              <button class="btn btn-ghost" data-action="edit_map" data-id="${escapeHtml(String(addr.id))}">Editar</button>
              <button class="btn btn-ghost" data-action="edit_meta" data-id="${escapeHtml(String(addr.id))}">Nombre/Notas</button>
              <button class="btn btn-ghost" data-action="default" data-id="${escapeHtml(String(addr.id))}">Predeterminada</button>
              <button class="btn btn-ghost" data-action="delete" data-id="${escapeHtml(String(addr.id))}">Eliminar</button>
            </div>
          </div>
        `;
      }).join('');
    }

    listEl?.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      const action = String(btn.getAttribute('data-action') || '').trim();
      const id = String(btn.getAttribute('data-id') || '').trim();
      const book = loadAddressBook(accountId);
      const addr = book.addresses.find(a => String(a.id) === id);
      if (!addr) return;
      if (action === 'use'){
        saveDeliveryAddressCache(Object.assign({}, addr, {
          instrucciones: sanitizeDeliveryNotes(addr.notes || '')
        }));
        setDefaultAddressInBook(id, accountId);
        setLastUsedAddressId(id, accountId);
        renderList();
        showToast('Dirección lista para usar en checkout', 2500);
        return;
      }
      if (action === 'edit_map'){
        const picked = await pickAddressWithSearchAndMap({
          title: 'Editar dirección',
          subtitle: 'Busca la dirección actualizada y confirmala en el mapa.',
          initialQuery: buildAddressDisplay(addr)
        });
        if (!picked) return;
        const updated = upsertAddressInBook({
          id: addr.id,
          label: addr.label || '',
          barrio: picked.barrio,
          calle: picked.calle,
          numeracion: picked.numeracion,
          postal_code: picked.postal_code,
          department: picked.department,
          query_hint: picked.query_hint || addr.query_hint || '',
          full_text: picked.full_text,
          lat: picked.lat,
          lon: picked.lon
        }, {
          accountId,
          setDefault: String(book.defaultId || '') === String(addr.id || '')
        });
        if (updated){
          saveDeliveryAddressCache(Object.assign({}, updated, {
            instrucciones: sanitizeDeliveryNotes(updated.notes || '')
          }));
          setLastUsedAddressId(updated.id, accountId);
          renderList();
          showToast('Dirección actualizada', 2200);
        }
        return;
      }
      if (action === 'edit_meta'){
        const meta = await showAddressDetailsModal({
          label: addr.label || '',
          notes: addr.notes || ''
        }, { title: 'Nombre e instrucciones' });
        if (!meta) return;
        const updated = upsertAddressInBook({
          id: addr.id,
          label: meta.label || '',
          notes: meta.notes || '',
          barrio: addr.barrio,
          calle: addr.calle,
          numeracion: addr.numeracion,
          postal_code: addr.postal_code,
          department: addr.department,
          query_hint: addr.query_hint || '',
          full_text: addr.full_text,
          lat: addr.lat,
          lon: addr.lon
        }, {
          accountId,
          setDefault: String(book.defaultId || '') === String(addr.id || '')
        });
        if (updated){
          if (String(getLastUsedAddressId(accountId) || '') === String(updated.id || '')){
            saveDeliveryAddressCache(Object.assign({}, updated, {
              instrucciones: sanitizeDeliveryNotes(updated.notes || '')
            }));
          }
          renderList();
          showToast('Nombre e instrucciones actualizados', 2200);
        }
        return;
      }
      if (action === 'default'){
        setDefaultAddressInBook(id, accountId);
        renderList();
        showToast('Dirección predeterminada actualizada', 2200);
        return;
      }
      if (action === 'delete'){
        const ok = await showConfirm('¿Eliminar esta dirección?');
        if (!ok) return;
        removeAddressFromBook(id, accountId);
        renderList();
        showToast('Dirección eliminada', 2200);
      }
    });

    addAddressBtn?.addEventListener('click', async () => {
      addAddressBtn.disabled = true;
      try{
        const picked = await pickAddressWithSearchAndMap({
          title: 'Ingresa tu dirección',
          subtitle: 'Escribe tu dirección y después confirmala en el mapa.'
        });
        if (!picked) return;
        const meta = await showAddressDetailsModal({}, { title: 'Nombre e instrucciones' });
        const alias = sanitizeAddressAlias(meta && meta.label ? meta.label : '');
        const notes = sanitizeDeliveryNotes(meta && meta.notes ? meta.notes : '');
        const bookNow = loadAddressBook(accountId);
        const saved = upsertAddressInBook({
          label: alias,
          notes,
          barrio: picked.barrio,
          calle: picked.calle,
          numeracion: picked.numeracion,
          postal_code: picked.postal_code,
          department: picked.department,
          query_hint: picked.query_hint || '',
          full_text: picked.full_text,
          lat: picked.lat,
          lon: picked.lon
        }, {
          accountId,
          setDefault: !bookNow.defaultId
        });
        if (saved){
          saveDeliveryAddressCache(Object.assign({}, saved, {
            instrucciones: sanitizeDeliveryNotes(saved.notes || '')
          }));
          setLastUsedAddressId(saved.id, accountId);
          renderList();
          showToast('Dirección guardada', 2200);
        }
      } finally {
        addAddressBtn.disabled = false;
      }
    });
    overlay.querySelector('[data-action="close_top"]')?.addEventListener('click', closeModal);
    overlay.querySelector('[data-action="close_bottom"]')?.addEventListener('click', closeModal);
    overlay.querySelector('[data-action="my_orders_bottom"]')?.addEventListener('click', ()=>{ showMyOrdersModal(); });
    overlay.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
      const ok = await showConfirm('¿Cerrar sesión ahora?');
      if (!ok) return;
      closeModal();
      logout();
    });

    const onKey = (ev) => {
      if (ev.key === 'Escape' && isTopDialogOverlay(overlay)) closeModal();
    };
    window.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay && isTopDialogOverlay(overlay)) closeModal();
    });

    renderList();
    setTimeout(()=>{ try{ addAddressBtn?.focus(); }catch(_){ } }, 60);

    fetchCurrentProfileSafe().then((profile) => {
      if (!profile) return;
      try{
        const nameEl = overlay.querySelector('#__acc_name');
        const emailEl = overlay.querySelector('#__acc_email');
        if (nameEl) nameEl.textContent = String(profile.full_name || fallbackName || 'Cuenta activa');
        if (emailEl) emailEl.textContent = String(profile.email || fallbackEmail || '');
      }catch(_){ }
      const profileAddress = normalizeAddressEntry({
        label: 'Principal',
        barrio: profile.barrio,
        calle: profile.calle,
        numeracion: profile.numeracion
      });
      if (profileAddress && isMendozaPrefill(profileAddress)){
        upsertAddressInBook(profileAddress, { accountId, setDefault: false });
        renderList();
      }
    }).catch(()=>{});
  }catch(e){
    console.error('openAccountModal failed', e);
    showAlert('No se pudo abrir Mi cuenta en este momento.', 'warning');
  }
}
function showGuestModal(){
  return new Promise((resolve)=>{
    try{
      ensureGlobalDialogStyles();
      // build a nicer guest contact modal (styled) and read inputs before removing
      const overlay = document.createElement('div'); overlay.className='__dialog_overlay'; overlay.style.zIndex = 3300;
      overlay.innerHTML = `
        <div class="__dialog __dialog--info" role="dialog" aria-modal="true" aria-label="Datos de contacto (invitado)">
          <div class="dialog-header"><span class="dialog-icon">ℹ️</span><h3>Datos de contacto (invitado)</h3></div>
          <div class="dialog-body">
            <div style="display:flex;flex-direction:column;gap:10px">
              <input id="__gname" type="text" placeholder="Nombre (opcional)" />
              <input id="__gemail" type="email" placeholder="Email (obligatorio)" />
              <input id="__gbarrio" type="text" placeholder="Barrio (obligatorio)" />
              <input id="__gcalle" type="text" placeholder="Calle (obligatorio)" />
              <input id="__gnumero" type="text" placeholder="Numeración (obligatoria)" />
            </div>
          </div>
          <div class="actions">
            <button class="btn btn-ghost" data-action="cancel">Cancelar</button>
            <button class="btn btn-primary" data-action="save">Guardar</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const dialog = overlay.querySelector('.__dialog');
      requestAnimationFrame(()=>{
        try{
          overlay.classList.add('open');
          if (dialog) dialog.classList.add('open');
        }catch(_){ }
      });
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
        const emailRaw = (document.getElementById('__gemail')?.value || '').trim();
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw);
        if (!emailOk) {
          try { showAlert('Para enviarte la confirmacion, ingresa un email valido.'); } catch(_){}
          try { document.getElementById('__gemail')?.focus(); } catch(_){}
          return;
        }
        const check = validateAddressInput({
          barrio: document.getElementById('__gbarrio')?.value || '',
          calle: document.getElementById('__gcalle')?.value || '',
          numeracion: document.getElementById('__gnumero')?.value || ''
        });
        if (!check.ok) {
          try { showAlert(check.message || 'Para entregar tu pedido, revisa la dirección.'); } catch(_){}
          try {
            if (check.field === 'barrio') document.getElementById('__gbarrio')?.focus();
            else if (check.field === 'calle') document.getElementById('__gcalle')?.focus();
            else document.getElementById('__gnumero')?.focus();
          } catch(_){}
          return;
        }
        const clean = check.value;
        const o = {
          name: (document.getElementById('__gname')?.value || '').trim(),
          email: emailRaw,
          barrio: clean.barrio,
          calle: clean.calle,
          numero: clean.numeracion
        };
        // persist guest info for future attempts / across reloads
        try{ localStorage.setItem('catalog:guest_info_v1', JSON.stringify(o)); }catch(e){}
        try{ saveDeliveryAddressCache({ barrio: clean.barrio, calle: clean.calle, numeracion: clean.numeracion }); }catch(_){ }
        try{
          const persisted = upsertAddressInBook({
            label: o.name ? ('Contacto ' + o.name) : 'Invitado',
            barrio: clean.barrio,
            calle: clean.calle,
            numeracion: clean.numeracion,
            query_hint: `${clean.calle} ${clean.numeracion}, ${clean.barrio}`
          }, { accountId: getCurrentAccountStorageId(), setDefault: true });
          if (persisted && persisted.id) setLastUsedAddressId(persisted.id, getCurrentAccountStorageId());
        }catch(_){ }
        cleanup(); resolve(o);
      });
      const onKey = (ev)=>{ if (ev.key === 'Escape') { cleanup(); resolve(null); } };
      window.addEventListener('keydown', onKey);
      // focus first input
      setTimeout(()=>{ try{ document.getElementById('__gname')?.focus(); }catch(_){ } }, 50);
    }catch(e){ console.error('showGuestModal failed', e); resolve(null); }
  });
}

async function syncMercadoPagoReturnToBackend({ paymentId, externalReference, status }){
  try{
    const body = {
      payment_id: paymentId || null,
      external_reference: externalReference || null,
      status: status || null
    };
    const headers = { 'Content-Type': 'application/json' };
    try{
      const token = getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }catch(_){ }

    const tryUrls = [];
    try{
      const pageOrigin = (location && location.protocol && location.protocol.startsWith('http') && location.origin) ? location.origin : null;
      if (typeof API_ORIGIN === 'string' && API_ORIGIN) {
        if (pageOrigin && pageOrigin !== API_ORIGIN) {
          tryUrls.push(API_ORIGIN + '/payments/mercadopago/sync');
        } else {
          tryUrls.push((pageOrigin || API_ORIGIN) + '/payments/mercadopago/sync');
        }
      } else if (pageOrigin) {
        tryUrls.push(pageOrigin + '/payments/mercadopago/sync');
      }
    }catch(_){ }
    tryUrls.push('/payments/mercadopago/sync');

    const seen = new Set();
    const ordered = tryUrls.filter(u => { if(!u || seen.has(u)) return false; seen.add(u); return true; });
    for (const url of ordered){
      try{
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          mode: 'cors'
        }, 8000);
        if (res && res.ok) return true;
      }catch(_){ }
    }
  }catch(_){ }
  return false;
}

function handleMercadoPagoReturn(){
  try{
    if (!location || !location.search) return;
    const params = new URLSearchParams(location.search);
    const qpPayment = String(params.get('payment') || '').trim().toLowerCase();
    const qpStatus = String(params.get('status') || params.get('collection_status') || '').trim().toLowerCase();
    const paymentId = String(params.get('payment_id') || '').trim();
    const externalRef = String(params.get('external_reference') || '').trim();

    let result = qpPayment;
    if (!result){
      if (qpStatus === 'approved') result = 'success';
      else if (qpStatus === 'pending' || qpStatus === 'in_process' || qpStatus === 'inprocess') result = 'pending';
      else if (qpStatus) result = 'failure';
    }
    if (!result && !paymentId && !externalRef) return;

    try{
      let syncStatus = qpStatus;
      if (!syncStatus){
        if (result === 'success') syncStatus = 'approved';
        else if (result === 'failure') syncStatus = 'rejected';
        else if (result === 'pending') syncStatus = 'in_process';
      }
      if (paymentId || externalRef || syncStatus) {
        syncMercadoPagoReturnToBackend({
          paymentId,
          externalReference: externalRef,
          status: syncStatus
        }).catch(()=>{});
      }
    }catch(_){ }

    if (result === 'success') {
      showAlert('Pago aprobado en Mercado Pago. Tu pedido fue recibido.', 'success');
    } else if (result === 'pending') {
      showAlert('Tu pago quedó pendiente. Te avisaremos cuando se confirme.', 'warning');
    } else if (result === 'failure') {
      showAlert('El pago no se pudo completar. Puedes intentar nuevamente.', 'danger');
    } else {
      // generic fallback when MP returns only ids/status variants
      showAlert('Recibimos el resultado del pago de Mercado Pago.', 'info');
    }

    // Clean URL so reloading doesn't show the payment dialog again.
    try{
      const clean = location.origin + location.pathname + (location.hash || '');
      history.replaceState({}, document.title, clean);
    }catch(_){ }
  }catch(e){
    console.warn('handleMercadoPagoReturn failed', e);
  }
}

try{
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', handleMercadoPagoReturn);
  else setTimeout(handleMercadoPagoReturn, 50);
}catch(_){ }

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

function setAuthButtonDisplay(btn, label){
  if (!btn) return;
  btn.classList.add('account-access');
  btn.innerHTML = `
    <span class="account-avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" role="presentation">
        <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8"></circle>
        <path d="M4 20c1.6-3.6 4.7-5.4 8-5.4s6.4 1.8 8 5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
      </svg>
    </span>
    <span class="account-label">${escapeHtml(String(label || 'Cuenta'))}</span>
  `;
}

function updateAuthUI(){
  const btn = document.getElementById('authButton');
  const token = getToken();
  if (!btn) return;
  if (token){
    const payload = parseJwt(token) || {};
    const email = payload.sub || payload.email || 'Cuenta';
    setAuthButtonDisplay(btn, 'Mi cuenta');
    btn.setAttribute('aria-label', 'Abrir mi cuenta');
    btn.title = String(email);
    btn.classList.add('logged');
  } else {
    setAuthButtonDisplay(btn, 'Mi cuenta');
    btn.setAttribute('aria-label', 'Iniciar sesión');
    btn.title = '';
    btn.classList.remove('logged');
  }
  updateRepeatOrderButton();
}
async function doRegister(){
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const geoPrefill = authLocationPrefill || loadLocationPrefillCache() || {};
  const barrio = (document.getElementById('regBarrio').value || '').trim() || String(geoPrefill.barrio || '').trim();
  const calle = (document.getElementById('regCalle').value || '').trim() || String(geoPrefill.calle || '').trim();
  const numero = (document.getElementById('regNumero').value || '').trim() || String(geoPrefill.numeracion || '').trim();
  const password = document.getElementById('regPassword').value;
  const err = document.getElementById('regError');
  err.textContent = '';
  if(!name || !email || !password){
    err.textContent = 'Nombre, email y contraseña son obligatorios';
    return;
  }
  try{
    const res = await fetchWithTimeout(AUTH_REGISTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: name,
        email,
        barrio,
        calle,
        numeracion: numero,
        password
      })
    }, 10000);
    if (res.status === 400){
      const js = await res.json().catch(() => ({}));
      err.textContent = js.detail || 'Error';
      return;
    }
    if (!res.ok){
      err.textContent = 'Registro falló';
      return;
    }
    if (barrio || calle || numero){
      saveDeliveryAddressCache({
        barrio,
        calle,
        numeracion: numero,
        lat: geoPrefill?.lat || null,
        lon: geoPrefill?.lon || null,
        full_text: geoPrefill?.full_text || geoPrefill?.label || ''
      });
    }
    await doLogin(email, password);
    closeAuthModal();
  }catch(e){
    if (e && e.name === 'AbortError') err.textContent = 'Tiempo de espera agotado';
    else err.textContent = 'No se pudo conectar con el servidor';
  }
}
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
      try{
        const accountId = getCurrentAccountStorageId();
        seedAddressBookFromKnownLocations(accountId);
      }catch(_){ }
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
  try{ document.getElementById('__account_overlay')?.remove(); }catch(_){ }
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
  initAuthLocationCard();
  // ensure login tab shown by default
  const loginPanel = document.getElementById('loginForm');
  const registerPanel = document.getElementById('registerForm');
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  if (tabLogin && tabRegister){ tabLogin.classList.add('active'); tabRegister.classList.remove('active'); }
  if (loginPanel && registerPanel){ loginPanel.style.display = 'block'; registerPanel.style.display = 'none'; }
  const cachedLocation = authLocationPrefill || loadLocationPrefillCache();
  authLocationPrefill = cachedLocation || null;
  updateAuthLocationCard(authLocationPrefill, authLocationPrefill ? 'Ubicación guardada lista para usar.' : 'Permití ubicación para cargar tu dirección más rápido.');
  try{
    if (!authLocationPrefill){
      const prompted = sessionStorage.getItem(LOCATION_PROMPT_SESSION_KEY) === '1';
      if (!prompted){
        sessionStorage.setItem(LOCATION_PROMPT_SESSION_KEY, '1');
        setTimeout(()=>{ requestAuthLocation({ auto: true }); }, 280);
      }
    }
  }catch(_){ }
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

function updateCustomerTypeStatusUI(){
  const status = document.getElementById('customerTypeStatus');
  const label = document.getElementById('customerTypeLabel');
  if (label) label.textContent = currentCustomerType === 'minorista' ? 'Perfil: Minorista' : 'Perfil: Mayorista';
  if (status) status.hidden = false;
}

function openCustomerTypeModal(){
  const modal = document.getElementById('customerTypeModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('customer-type-locked');
}

function closeCustomerTypeModal(){
  const modal = document.getElementById('customerTypeModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('customer-type-locked');
}

function applyCustomerType(value, opts = {}){
  const options = opts || {};
  const persist = options.persist !== false;
  const rerender = options.rerender !== false;
  currentCustomerType = normalizeCustomerType(value);
  if (persist) setStoredCustomerType(currentCustomerType);
  updateCustomerTypeStatusUI();
  if (rerender && Array.isArray(productsRaw) && productsRaw.length) {
    products = productsRaw.map(normalize);
    try{ syncCartPricesForCustomerType(); }catch(_){ }
    try{ render({ animate: true }); }catch(_){ }
    try{ renderCart(); }catch(_){ }
  }
}

function initCustomerTypeSelection(){
  const modal = document.getElementById('customerTypeModal');
  if (!modal) return;
  const buttons = modal.querySelectorAll('.customer-type-btn[data-customer-type]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const selected = btn.getAttribute('data-customer-type');
      applyCustomerType(selected, { persist: true, rerender: true });
      closeCustomerTypeModal();
    });
  });
  const changeBtn = document.getElementById('changeCustomerTypeBtn');
  if (changeBtn) changeBtn.addEventListener('click', () => openCustomerTypeModal());
  const stored = getStoredCustomerType();
  if (stored) {
    applyCustomerType(stored, { persist: false, rerender: false });
    closeCustomerTypeModal();
  } else {
    applyCustomerType(CUSTOMER_TYPE_DEFAULT, { persist: false, rerender: false });
    openCustomerTypeModal();
  }
}

// wire auth modal and button (DOMContentLoaded handled later)
document.addEventListener('DOMContentLoaded', ()=>{
  try{ initCustomerTypeSelection(); }catch(e){ console.warn('initCustomerTypeSelection failed', e); }
  initCatalogHeaderLogo();
  updateAuthUI();
  try{ initAuthLocationCard(); }catch(e){ console.warn('initAuthLocationCard failed', e); }
  const authBtn = document.getElementById('authButton');
  const repeatBtn = document.getElementById('repeatLastOrderBtn');
  if (authBtn) authBtn.addEventListener('click', async ()=>{
    const token = getToken();
    if (token){ openAccountModal(); return; }
    openAuthModal();
  });
  if (repeatBtn && !repeatBtn.dataset.bound) {
    repeatBtn.dataset.bound = '1';
    repeatBtn.addEventListener('click', ()=>{ repeatLastOrder(); });
  }
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
      const customerTypeChosen = !!getStoredCustomerType();
      if (!shown && customerTypeChosen) {
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

