const API_URL = "https://backend-0lcs.onrender.com/productos";

const grid = document.getElementById("catalogGrid");
const searchInput = document.getElementById("searchInput");
const filterButtons = document.querySelectorAll(".filters button");

let products = [];
let currentFilter = "all";

fetch(API_URL)
  .then(res => res.json())
  .then(data => {
    products = data;
    render();
  })
  .catch(() => {
    grid.innerHTML = "<p>No se pudieron cargar productos</p>";
  });

function render() {
  const search = searchInput.value.toLowerCase();

  const filtered = products.filter(p => {
    const matchesSearch =
      p.nombre.toLowerCase().includes(search) ||
      (p.descripcion || "").toLowerCase().includes(search);

    const matchesFilter =
      currentFilter === "all" || p.categoria === currentFilter;

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

    card.innerHTML = `
      <div class="product-image">
        <img src="${p.imagen}" alt="${p.nombre}">
      </div>
      <div class="product-info">
        <h3>${p.nombre}</h3>
        <p>${p.descripcion || ""}</p>
        <div class="price">$${p.precio}</div>
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
