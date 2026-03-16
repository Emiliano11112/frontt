const API_URL = 'https://backend-0lcs.onrender.com';
const API_ORIGIN = new URL(API_URL).origin;
const PRODUCT_FETCH_LIMIT = 5000;

let brandSearch = null;
let brandGrid = null;
let brandLetters = null;
let brandCount = null;
let activeLetter = 'all';
let brands = [];

const numFmt0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });

const BRAND_LOGOS = {
  'ramolac': 'images/ramolac.png',
  'santa maria': 'images/santamaria.png',
  'santa maría': 'images/santamaria.png',
  'swift': 'images/swift.png',
  'don yeyo': 'images/donyeyo.png',
  'deviano': 'images/deviano.png',
  'cada dia': 'images/cada dia.png',
  'cadadia': 'images/cada dia.png',
  'el artesano': 'images/El Artesano.jpeg',
  'el artesano de marcos paz': 'images/El Artesano.jpeg',
  'don decimo': 'images/Don Decimo.jpeg',
  'don décimo': 'images/Don Decimo.jpeg',
  '3l': 'images/3L.png',
  '3l lacteos': 'images/3L.png',
  '3l lácteos': 'images/3L.png',
  'la blanca': 'images/La Blanca.png',
  'lablanca': 'images/La Blanca.png',
  'la blanca sa': 'images/La Blanca.png',
  'la blanca s a': 'images/La Blanca.png',
  'la casona': 'images/La Casona.jpg',
  'la casoma': 'images/La Casona.jpg',
  'fiambres la casona': 'images/La Casona.jpg',
  'fiambres la casoma': 'images/La Casona.jpg',
  'la quesera': 'images/La Quesera.png',
  'sys': 'images/SyS.png',
  's y s': 'images/SyS.png',
  'tacural': 'images/Tacural.jpg',
  'tapalque': 'images/Tapalque.png',
  'tapelque': 'images/Tapelque.png',
  'alimentos tapalque': 'images/Tapalque.png',
  'tonadita': 'images/Tonadita.png',
  'sancor': 'images/Sancor.jpeg',
  'sancór': 'images/Sancor.jpeg',
  'cerdo y compania': 'images/cerdo y compañia.jpg',
  'cerdo y compañía': 'images/cerdo y compañia.jpg',
  'cerdo y compañia': 'images/cerdo y compañia.jpg',
  'cerdo y cia': 'images/cerdo y compañia.jpg',
  'cerdo y cía': 'images/cerdo y compañia.jpg',
  'natura': 'images/natura.png',
  'las tres ninas': 'images/lastresniñas.png',
  'las tres niñas': 'images/lastresniñas.png',
  'paladini': 'images/paladini.png',
  'fox': 'images/fox.png',
  'chamen': 'images/chamen.png',
  'marlina': 'images/marlina.png',
  'trozer': 'images/trozer.jpg',
  'cerdo y compania': 'images/cerdo y compañia.jpg',
  'cerdo y compañia': 'images/cerdo y compañia.jpg'
};

function escapeHtml(str){
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value){
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function letterForBrand(name){
  const clean = String(name || '').trim();
  if (!clean) return '#';
  const first = clean[0].toUpperCase();
  return /[A-ZÁÉÍÓÚÑ]/.test(first) ? first : '#';
}

function getBrandLogo(name){
  const key = normalizeText(name || '');
  if (BRAND_LOGOS[key]) return BRAND_LOGOS[key];
  // fallback: match substrings (handles "La Blanca SA", "Cerdo y Cía." etc.)
  try{
    const entries = Object.entries(BRAND_LOGOS);
    for (const [k, v] of entries){
      if (key.includes(k)) return v;
    }
  }catch(_){ }
  return '';
}

function buildLogoHtml(src, alt){
  if (!src) return '';
  const webp = src.replace(/\.(png|jpe?g)$/i, '.webp');
  const encodedWebp = webp.replace(/ /g, '%20');
  const encodedSrc = src.replace(/ /g, '%20');
  return `<picture class="brand-card-logo"><source type="image/webp" srcset="${encodedWebp}"><img src="${encodedSrc}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" width="160" height="100"></picture>`;
}

async function fetchProducts(){
  const applyLimit = (url) => {
    try{
      if (!url) return url;
      if (!/\/(products|productos)(\?|$)/i.test(url)) return url;
      if (url.includes('limit=')) return url;
      const joiner = url.includes('?') ? '&' : '?';
      return url + joiner + `skip=0&limit=${PRODUCT_FETCH_LIMIT}`;
    }catch(_){ return url; }
  };
  const tryUrls = [
    API_ORIGIN + '/products',
    API_ORIGIN + '/api/products',
    API_ORIGIN + '/api/v1/products',
    '/products',
    'products.json'
  ];
  for (const url of tryUrls){
    try{
      const res = await fetch(applyLimit(url), { cache: 'no-store' });
      if (!res.ok) continue;
      const json = await res.json();
      if (Array.isArray(json)) return json;
      if (json && Array.isArray(json.products)) return json.products;
      if (json && Array.isArray(json.data)) return json.data;
    }catch(_){ }
  }
  return [];
}

function buildBrands(list){
  const map = new Map();
  (list || []).forEach((p) => {
    const raw = String(p.brand || p.marca || '').trim();
    if (!raw) return;
    const key = normalizeText(raw);
    if (!key) return;
    const entry = map.get(key) || { name: raw, key, count: 0, letter: letterForBrand(raw) };
    entry.count += 1;
    map.set(key, entry);
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function renderLetters(){
  if (!brandLetters) return;
  const letters = Array.from(new Set(brands.map(b => b.letter))).sort((a, b) => a.localeCompare(b, 'es'));
  brandLetters.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.textContent = 'Todas';
  allBtn.className = activeLetter === 'all' ? 'active' : '';
  allBtn.addEventListener('click', () => { activeLetter = 'all'; render(); });
  brandLetters.appendChild(allBtn);

  letters.forEach((letter) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = letter;
    if (activeLetter === letter) btn.classList.add('active');
    btn.addEventListener('click', () => { activeLetter = letter; render(); });
    brandLetters.appendChild(btn);
  });
}

function render(){
  if (!brandGrid) return;
  const q = normalizeText(brandSearch ? brandSearch.value : '');
  const filtered = brands.filter((b) => {
    const matchesLetter = activeLetter === 'all' || b.letter === activeLetter;
    const matchesQuery = !q || normalizeText(b.name).includes(q);
    return matchesLetter && matchesQuery;
  });

  if (brandCount) {
    brandCount.textContent = `${numFmt0.format(filtered.length)} marca${filtered.length === 1 ? '' : 's'}`;
  }

  brandGrid.innerHTML = '';
  if (!filtered.length){
    brandGrid.innerHTML = '<div class="brand-empty">No encontramos marcas con esos filtros.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  filtered.forEach((b) => {
    const card = document.createElement('article');
    card.className = 'brand-card-item';
    const logo = getBrandLogo(b.name);
    const logoHtml = logo ? buildLogoHtml(logo, b.name) : '';
    card.innerHTML = `
      ${logoHtml}
      <h3>${escapeHtml(b.name)}</h3>
      <div class="brand-card-meta">${numFmt0.format(b.count)} producto${b.count === 1 ? '' : 's'}</div>
      <div class="brand-card-actions">
        <a href="catalogo.html?brand=${encodeURIComponent(b.name)}">Ver productos</a>
      </div>
    `;
    frag.appendChild(card);
  });
  brandGrid.appendChild(frag);
}

function init(){
  brandSearch = document.getElementById('brandSearch');
  brandGrid = document.getElementById('brandGrid');
  brandLetters = document.getElementById('brandLetters');
  brandCount = document.getElementById('brandCount');

  const clearBtn = document.getElementById('clearBrandFilters');
  const searchClear = document.getElementById('brandSearchClear');

  if (clearBtn) clearBtn.addEventListener('click', () => {
    activeLetter = 'all';
    if (brandSearch) brandSearch.value = '';
    renderLetters();
    render();
  });
  if (searchClear) searchClear.addEventListener('click', () => {
    if (brandSearch) brandSearch.value = '';
    brandSearch && brandSearch.focus();
    render();
  });
  if (brandSearch) brandSearch.addEventListener('input', () => render());

  fetchProducts().then((list) => {
    brands = buildBrands(list);
    renderLetters();
    render();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
