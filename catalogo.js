document.addEventListener("DOMContentLoaded", () => {

  const ENDPOINTS = [
    "/api/productos",
    "/productos",
    "/api/products",
    "/products",
    "http://localhost:3000/api/productos",
    "http://localhost:3000/productos"
  ];

  const grid = document.getElementById("catalogGrid");
  const searchInput = document.getElementById("searchInput");
  const filterButtons = document.querySelectorAll(".filters button");

  let productos = [];
  let filtroActual = "all";

  async function cargarProductos() {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;

        const data = await res.json();
        if (!Array.isArray(data)) continue;

        productos = normalizar(data);
        render();
        return;
      } catch (_) {}
    }

    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;opacity:.6">
        Backend no encontrado o JSON inválido
      </div>
    `;
  }

  function normalizar(data) {
    return data.map(p => ({
      nombre: p.nombre || p.name || "Sin nombre",
      descripcion: p.descripcion || p.description || "",
      precio: p.precio || p.price || 0,
      categoria: p.categoria || p.category || "otros",
      promocion: p.promocion || p.promo || false,
      imagen:
        p.imagen ||
        p.image ||
        p.img ||
        "https://via.placeholder.com/200x150?text=Sin+imagen"
    }));
  }

  function render() {
    const texto = searchInput.value.toLowerCase();
    grid.innerHTML = "";

    const filtrados = productos.filter(p => {
      const okFiltro =
        filtroActual === "all" ||
        (filtroActual === "promociones" && p.promocion) ||
        p.categoria === filtroActual;

      const okTexto =
        p.nombre.toLowerCase().includes(texto) ||
        p.descripcion.toLowerCase().includes(texto);

      return okFiltro && okTexto;
    });

    if (filtrados.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;opacity:.6">
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
          <img src="${p.imagen}" loading="lazy"
            onerror="this.src='https://via.placeholder.com/200x150?text=Sin+imagen'">
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
});
