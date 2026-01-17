document.addEventListener("DOMContentLoaded", () => {

  const API_URL = "/api/productos"; // ESTE ES EL ÚNICO PUNTO DE BACKEND

  const grid = document.getElementById("catalogGrid");
  const searchInput = document.getElementById("searchInput");
  const filterButtons = document.querySelectorAll(".filters button");

  let productos = [];
  let filtroActual = "all";

  async function cargarProductos() {
    try {
      const res = await fetch(API_URL, { cache: "no-store" });

      if (!res.ok) throw new Error("Backend no responde");

      const data = await res.json();

      if (!Array.isArray(data)) throw new Error("JSON inválido");

      productos = data;
      render();
    } catch (err) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;opacity:.6;text-align:center">
          No se pudieron cargar productos
        </div>
      `;
    }
  }

  function render() {
    const texto = searchInput.value.toLowerCase();
    grid.innerHTML = "";

    const filtrados = productos.filter(p => {
      const matchFiltro =
        filtroActual === "all" ||
        (filtroActual === "promociones" && p.promocion === true) ||
        p.categoria === filtroActual;

      const matchTexto =
        p.nombre?.toLowerCase().includes(texto) ||
        p.descripcion?.toLowerCase().includes(texto);

      return matchFiltro && matchTexto;
    });

    if (filtrados.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;opacity:.6;text-align:center">
          Sin resultados
        </div>
      `;
      return;
    }

    filtrados.forEach(p => {
      const card = document.createElement("article");
      card.className = "product-card";

      card.innerHTML = `
        ${p.promocion ? `<span class="tag">Promo</span>` : ""}
        <div class="product-image">
          <img src="${p.imagen}" alt="${p.nombre}" loading="lazy"
               onerror="this.src='https://via.placeholder.com/200x150?text=Sin+imagen'">
        </div>
        <div class="product-info">
          <h3>${p.nombre}</h3>
          <p>${p.descripcion || ""}</p>
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
});
