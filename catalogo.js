// API: prefer the real endpoint but tolerate variations (English/Spanish)
const API_URL = "https://backend-0lcs.onrender.com/products";
const API_ORIGIN = new URL(API_URL).origin;

const grid = document.getElementById("catalogGrid");
const searchInput = document.getElementById("searchInput");
const filterButtons = document.querySelectorAll(".filters button");

let products = [];
let currentFilter = "all";

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
  grid.innerHTML = `<p class="message ${level}">${msg}</p>`;
}

// intenta cargar del backend; si falla, intenta fallback local (products.json)
fetch(API_URL, { mode: 'cors' })
  .then(res => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  })
  .then(data => {
    products = data.map(normalize);
    render();
  })
  .catch(err => {
    console.error('Error cargando productos desde backend:', err);
    // mensaje al usuario con pista sobre CORS/endpoint
    showMessage('No se pudieron cargar productos desde el backend. Ver consola para más detalles. Se usará el catálogo local si está disponible. ⚠️', 'warning');
    // fallback local
    fetch('products.json')
      .then(r => r.json())
      .then(local => {
        products = local.map(normalize);
        render();
      })
      .catch(() => {
        showMessage('No hay productos disponibles', 'error');
      });
  });

function render() {
  const search = (searchInput.value || '').toLowerCase();

  const filtered = products.filter(p => {
    const matchesSearch =
      (p.nombre || '').toLowerCase().includes(search) ||
      (p.descripcion || '').toLowerCase().includes(search);

    const matchesFilter =
      currentFilter === "all" || (p.categoria || '').toLowerCase() === currentFilter.toLowerCase();

    return matchesSearch && matchesFilter;
  });

  grid.innerHTML = "";

  if (filtered.length === 0) {
    grid.innerHTML = "<p>No hay resultados</p>";
    return;
  }

  filtered.forEach(p => {
    const card = document.createElement("article");
    card.className = "product-card";

    const imgSrc = p.imagen || 'images/placeholder.png';

    card.innerHTML = `
      <div class="product-image">
        <img src="${imgSrc}" alt="${escapeHtml(p.nombre)}">
      </div>
      <div class="product-info">
        <h3>${escapeHtml(p.nombre)}</h3>
        <p>${escapeHtml(p.descripcion)}</p>
        <div class="price">$${Number(p.precio).toFixed(2)}</div>
      </div>
    `;

    grid.appendChild(card);
  });
}

searchInput.addEventListener("input", render);

filterButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    filterButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    render();
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