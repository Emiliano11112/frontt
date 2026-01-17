const API_URL = "/api/productos"; // ← tu backend real acá

const grid = document.getElementById("catalogGrid");
const searchInput = document.getElementById("searchInput");
const filterButtons = document.querySelectorAll(".filters button");

let productos = [];
let filtroActual = "all";

async function cargarProductos() {
  const res = await fetch(API_URL);
  productos = await res.json();
  render();
}

function render() {
  const texto = searchInput.value.toLowerCase();

  const filtrados = productos.filter(p => {
    const matchFiltro =
      filtroActual === "all" ||
      (filtroActual === "promociones" && p.promocion) ||
      p.categoria === filtroActual;

    const matchTexto =
      p.nombre.toLowerCase().includes(texto) ||
      p.descripcion.toLowerCase().includes(texto);

    return matchFiltro && matchTexto;
  });

  grid.innerHTML = "";

  filtrados.forEach(p => {
    const card = document.createElement("article");
    card.className = "product-card";

    card.innerHTML = `
      ${p.promocion ? `<span class="tag">Promo</span>` : ""}
      <div class="product-image">
        <img src="${p.imagen}" alt="${p.nombre}" loading="lazy">
      </div>
      <div class="product-info">
        <h3>${p.nombre}</h3>
        <p>${p.descripcion}</p>
        <div class="product-footer">
          <span class="price">$${p.precio}</span>
        </div>
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
    filtroActual = btn.dataset.filter;
    render();
  });
});

cargarProductos();
