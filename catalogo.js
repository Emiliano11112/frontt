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
    if (animate && !reduceMotion) {
      card.classList.add('reveal');
      card.style.setProperty('--i', i);
      card.setAttribute('data-i', i);
    }
    const imgSrc = p.imagen || 'images/placeholder.png';
    card.innerHTML = `
      <div class="product-image">
        <img src="${imgSrc}" alt="${escapeHtml(p.nombre)}" loading="lazy">
      </div>
      <div class="product-info">
        <h3>${escapeHtml(p.nombre)}</h3>
        <p>${escapeHtml(p.descripcion)}</p>
        <div class="price">$${Number(p.precio).toFixed(2)}</div>
      </div>`;
    frag.appendChild(card);
  });
  grid.appendChild(frag);

  // if animated, remove reveal class after animation to keep DOM clean
  if (animate && !reduceMotion) {
    const revealed = grid.querySelectorAll('.product-card.reveal');
    revealed.forEach((el) => el.addEventListener('animationend', () => el.classList.remove('reveal'), { once: true }));
  }
}

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