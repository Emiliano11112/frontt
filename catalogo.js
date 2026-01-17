const API_BASE = 'https://backend-0lcs.onrender.com';

const catalogGrid = document.getElementById('catalogGrid');
const searchInput = document.getElementById('search');
const filterButtons = document.querySelectorAll('.filter-btn');

let PRODUCTS = [];
let FILTER = 'all';
let CART = JSON.parse(localStorage.getItem('cart') || '[]');

/* =========================
   FETCH PRODUCTS
========================= */
async function loadProducts() {
  const res = await fetch(`${API_BASE}/products`);
  PRODUCTS = await res.json();
  renderProducts(PRODUCTS);
}

/* =========================
   RENDER
========================= */
function renderProducts(list) {
  catalogGrid.innerHTML = '';

  if (!list.length) {
    catalogGrid.innerHTML = `<p style="opacity:.6">No hay productos</p>`;
    return;
  }

  list.forEach(p => {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.dataset.category = p.category || '';

    card.innerHTML = `
      <div class="product-image">
        <img src="${API_BASE}${p.image_url || ''}" alt="${p.name}">
      </div>
      <div class="product-info">
        <h3>${p.name}</h3>
        <p>${p.description || ''}</p>
        <div class="product-footer">
          <span class="price">$${p.price}</span>
          <button class="add-btn">Agregar</button>
        </div>
      </div>
    `;

    card.querySelector('.add-btn').onclick = () => addToCart(p);
    catalogGrid.appendChild(card);
  });
}

/* =========================
   FILTERS
========================= */
function applyFilters() {
  let filtered = [...PRODUCTS];

  if (FILTER !== 'all') {
    filtered = filtered.filter(p => p.category === FILTER);
  }

  const q = searchInput.value.toLowerCase().trim();
  if (q) {
    filtered = filtered.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q)
    );
  }

  renderProducts(filtered);
}

filterButtons.forEach(btn => {
  btn.onclick = () => {
    filterButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    FILTER = btn.dataset.filter;
    applyFilters();
  };
});

searchInput.addEventListener('input', applyFilters);

/* =========================
   CART
========================= */
function addToCart(product) {
  const found = CART.find(p => p.id === product.id);
  if (found) {
    found.qty++;
  } else {
    CART.push({ ...product, qty: 1 });
  }
  saveCart();
}

function saveCart() {
  localStorage.setItem('cart', JSON.stringify(CART));
  renderCart();
}

function renderCart() {
  const drawer = document.getElementById('cartDrawer');
  const floating = document.getElementById('cartFloating');

  if (!drawer || !floating) return;

  drawer.innerHTML = `
    <h3>Carrito</h3>
    ${CART.map(p => `
      <div class="cart-item">
        <span>${p.name} x${p.qty}</span>
        <strong>$${p.price * p.qty}</strong>
      </div>
    `).join('')}
    <hr>
    <strong>Total: $${CART.reduce((a,p)=>a+p.price*p.qty,0)}</strong>
  `;

  floating.textContent = CART.reduce((a,p)=>a+p.qty,0);
  floating.style.display = CART.length ? 'flex' : 'none';
}

/* =========================
   INIT
========================= */
loadProducts();
renderCart();
