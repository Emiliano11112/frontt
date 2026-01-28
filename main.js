// Carrusel de imágenes promocionales dinámico
document.addEventListener('DOMContentLoaded', function() {
	const carousel = document.querySelector('.promo-carousel');
	const leftBtn = document.querySelector('.promo-arrow-left');
	const rightBtn = document.querySelector('.promo-arrow-right');
	let promoImages = [];
	let current = 0;

	// Cambia esta URL por la del endpoint real del backend
	const PROMOS_API = '/api/promos';

	function renderImage(idx) {
		if (!promoImages.length) {
			carousel.innerHTML = '<div style="text-align:center;width:100%">No hay imágenes promocionales</div>';
			return;
		}
		carousel.innerHTML = '';
		const img = document.createElement('img');
		img.src = promoImages[idx].url;
		img.alt = promoImages[idx].alt || 'Imagen promocional';
		carousel.appendChild(img);
	}

	function showPrev() {
		if (!promoImages.length) return;
		current = (current - 1 + promoImages.length) % promoImages.length;
		renderImage(current);
	}
	function showNext() {
		if (!promoImages.length) return;
		current = (current + 1) % promoImages.length;
		renderImage(current);
	}

	leftBtn && leftBtn.addEventListener('click', showPrev);
	rightBtn && rightBtn.addEventListener('click', showNext);

	// Cargar imágenes desde el backend
	fetch(PROMOS_API)
		.then(res => res.json())
		.then(data => {
			promoImages = data;
			current = 0;
			renderImage(current);
		})
		.catch(() => {
			carousel.innerHTML = '<div style="text-align:center;width:100%">No se pudieron cargar las imágenes</div>';
		});
});
// Mobile menu toggle
const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav');
if(menuToggle){
	menuToggle.addEventListener('click', () => {
		nav.classList.toggle('open');
		const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
		const now = !expanded;
		menuToggle.setAttribute('aria-expanded', String(now));
		// Swap visual icon for close/open and prevent body scroll when open
		menuToggle.textContent = now ? '✕' : '☰';
		document.body.classList.toggle('nav-open', now);
	});

	// Ensure menu closes when resizing to desktop widths
	window.addEventListener('resize', () => {
		if (window.innerWidth > 900 && nav.classList.contains('open')) {
			nav.classList.remove('open');
			menuToggle.setAttribute('aria-expanded','false');
			menuToggle.textContent = '☰';
			document.body.classList.remove('nav-open');
		}
	});
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
	anchor.addEventListener('click', function (e) {
		const targetId = this.getAttribute('href');
		if (targetId && targetId.startsWith('#')) {
			e.preventDefault();
			const el = document.querySelector(targetId);
			if (el) el.scrollIntoView({behavior: 'smooth', block: 'start'});
			// close mobile nav when clicked
			if (nav.classList.contains('open')) nav.classList.remove('open');
		}
	});
});

// Simple contact form handler
function handleContact(e){
	e.preventDefault();
	const form = document.querySelector('.contact-form');
	const name = document.getElementById('name').value.trim();
	const email = document.getElementById('email').value.trim();
	const message = document.getElementById('message').value.trim();
	const msgBox = document.querySelector('.contact-form .form-msg');
	const submitButton = form.querySelector('button[type="submit"]');

	function setLoading(isLoading){
		if(!submitButton) return;
		if(isLoading){
			submitButton.classList.add('is-loading');
			submitButton.disabled = true;
			submitButton.setAttribute('aria-busy', 'true');
		} else {
			submitButton.classList.remove('is-loading');
			submitButton.disabled = false;
			submitButton.setAttribute('aria-busy', 'false');
		}
	}
	if(!name || !email || !message){
		// Simple inline feedback: show message for a short time
		if(msgBox){
			msgBox.innerText = 'Por favor completa todos los campos obligatorios.';
			msgBox.classList.add('show');
			setTimeout(() => msgBox.classList.remove('show'), 3000);
		} else {
			alert('Por favor completa todos los campos obligatorios.');
		}
		return false;
	}
	// Simulate sending; show spinner while 'sending'
	setLoading(true);
	setTimeout(() => {
		setLoading(false);
		if(msgBox){
			msgBox.innerText = `Gracias ${name}! Tu solicitud fue recibida. Nos contactaremos al correo ${email}.`;
			msgBox.classList.add('show');
			// remove message after 4s
			setTimeout(() => msgBox.classList.remove('show'), 4000);
		} else {
			alert(`Gracias ${name}! Tu solicitud fue recibida. Nos contactaremos en breve al correo ${email}.`);
		}
		form.reset();
		document.getElementById('name').focus();
	}, 900);
	return false;
}

// Scroll reveal for cards and sections
const observer = new IntersectionObserver((entries) => {
	entries.forEach(entry => {
		if(entry.isIntersecting){
			entry.target.classList.add('in-view');
		}
	});
},{threshold: 0.15});
document.querySelectorAll('.card, .log-card, .about-text, .about-values, .product-card, .hero-text').forEach(el => {
	observer.observe(el);
});

