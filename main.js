// Carrusel de imÃ¡genes promocionales dinÃ¡mico
document.addEventListener('DOMContentLoaded', function() {
	const carousel = document.querySelector('.promo-carousel');
	// If the page doesn't include the promo carousel, skip promo initialization
	if(!carousel){ console.debug('[promos] .promo-carousel not found - skipping promos init'); return; }
	const leftBtn = document.querySelector('.promo-arrow-left');
	const rightBtn = document.querySelector('.promo-arrow-right');
	let promoImages = [];
	let current = 0;
	let autoplayTimer = null;
	let refreshTimer = null;

	function renderIndicators(){
		const container = carousel.parentElement.querySelector('.promo-indicators');
		if(!container) return;
		container.innerHTML = '';
		for(let i=0;i<promoImages.length;i++){
			const btn = document.createElement('button');
			btn.className = 'promo-indicator';
			btn.setAttribute('aria-label', `Ir a imagen ${i+1}`);
			btn.dataset.index = String(i);
			btn.type = 'button';
			btn.addEventListener('click', () => { current = i; renderImage(current); startAutoplay(); });
			container.appendChild(btn);
		}
		updateIndicators(current);
	}

	function updateIndicators(activeIdx){
		const container = carousel.parentElement.querySelector('.promo-indicators');
		if(!container) return;
		const nodes = container.querySelectorAll('.promo-indicator');
		nodes.forEach((n, idx) => {
			n.classList.toggle('active', idx === activeIdx);
			if(idx === activeIdx){ n.setAttribute('aria-current','true'); } else { n.removeAttribute('aria-current'); }
		});
	}

	// Cambia esta URL por la del endpoint real del backend
	const PROMOS_API = '/api/promos';

	function sanitizePromoItems(items){
		if(!Array.isArray(items)) return [];
		return items.map(i => ({ url: i && i.url ? i.url : '', name: i && i.name ? i.name : '', alt: (i && i.alt) || (i && i.name) || '' }));
	}

	function renderImage(idx) {
		if (!promoImages.length) {
			carousel.innerHTML = '<div style="text-align:center;width:100%">No hay imagenes promocionales</div>';
			return;
		}
		// Crossfade animation: insert new img and fade out the old one
		// Use two fixed image elements (front/back) to avoid DOM accumulation and visual glitches
		if (!promoImages.length) {
			// remove any imgs and show placeholder
			const existing = carousel.querySelectorAll('img');
			existing.forEach(n => n.parentNode && n.parentNode.removeChild(n));
			carousel.innerHTML = '<div style="text-align:center;width:100%">No hay imagenes promocionales</div>';
			return;
		}
		// ensure two image slots exist
		let slotA = carousel.querySelector('.promo-slot-A');
		let slotB = carousel.querySelector('.promo-slot-B');
		if(!slotA){ slotA = document.createElement('img'); slotA.className = 'promo-img promo-slot-A'; slotA.style.zIndex = 1; carousel.appendChild(slotA); }
		if(!slotB){ slotB = document.createElement('img'); slotB.className = 'promo-img promo-slot-B'; slotB.style.zIndex = 0; carousel.appendChild(slotB); }
		// track active slot on the carousel element
		if(typeof carousel._activeSlot === 'undefined') carousel._activeSlot = 0; // 0 -> A visible, 1 -> B visible
		const activeSlot = carousel._activeSlot;
		const activeImg = activeSlot === 0 ? slotA : slotB;
		const nextImg = activeSlot === 0 ? slotB : slotA;
		// prepare next image
		nextImg.src = promoImages[idx].url;
		nextImg.alt = promoImages[idx].alt || 'Imagen promocional';
		nextImg.classList.remove('visible','exiting');
		nextImg.style.zIndex = 2;
		// force reflow then make it visible
		void nextImg.offsetWidth;
		nextImg.classList.add('visible');
		// hide active image
		activeImg.classList.remove('visible');
		activeImg.classList.add('exiting');
		activeImg.style.zIndex = 1;
		// cleanup exiting class after transition
		const FADE_MS = 600;
		const onCleanup = () => { activeImg.classList.remove('exiting'); };
		activeImg.addEventListener('transitionend', function handler(){ activeImg.removeEventListener('transitionend', handler); onCleanup(); });
		setTimeout(onCleanup, FADE_MS + 80);
		// flip active slot
		carousel._activeSlot = 1 - activeSlot;
		// update indicators to reflect current
		try{ updateIndicators(current); }catch(_){ }
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

	// Encapsular fetch+render en una funciÃ³n para reuso (autorefresh)
	async function loadPromos(){
		try{
			const resp = await fetch(PROMOS_API);
			if(resp.ok){
				const data = await resp.json();
				if(Array.isArray(data) && data.length>0){
					promoImages = sanitizePromoItems(data);
					if(!promoImages.length){ carousel.innerHTML = '<div style="text-align:center;width:100%">No hay imagenes promocionales</div>'; return; }
					if(current >= promoImages.length) current = 0;
					renderIndicators();
					renderImage(current);
					// arrancar autoplay luego de cargar imÃ¡genes
					startAutoplay();
					return;
				}
			}
		}catch(e){ /* ignore and fallback */ }
		// fallback to explicit backend origin
		try{
			const r2 = await fetch('https://backend-0lcs.onrender.com/api/promos');
			if(r2.ok){
				let d2 = await r2.json();
				if(Array.isArray(d2) && d2.length>0){
					d2 = d2.map(i => { if (i && i.url && i.url.startsWith('/')) i.url = 'https://backend-0lcs.onrender.com' + i.url; return i; });
					promoImages = sanitizePromoItems(d2);
					if(!promoImages.length){ carousel.innerHTML = '<div style="text-align:center;width:100%">No hay imagenes promocionales</div>'; return; }
					if(current >= promoImages.length) current = 0;
					renderIndicators();
					renderImage(current);
					// arrancar autoplay luego de cargar imÃ¡genes
					startAutoplay();
					return;
				}
			}
		}catch(e){ /* final fallback */ }
		carousel.innerHTML = '<div style="text-align:center;width:100%">No se pudieron cargar las imagenes</div>';
	}

	// iniciar carga inicial
	loadPromos();

	// autoplay cada 10s
	function startAutoplay(){
		stopAutoplay();
		if(promoImages && promoImages.length>1){
			autoplayTimer = setInterval(() => { showNext(); }, 10000);
		}
	}
	function stopAutoplay(){ if(autoplayTimer){ clearInterval(autoplayTimer); autoplayTimer = null; } }

	// pause autoplay on hover or focus for better UX
	carousel.addEventListener('mouseenter', () => { stopAutoplay(); });
	carousel.addEventListener('mouseleave', () => { startAutoplay(); });
	carousel.addEventListener('focusin', () => { stopAutoplay(); });
	carousel.addEventListener('focusout', () => { startAutoplay(); });

	// refrescar la lista cada 30s
	function startRefresh(){
		stopRefresh();
		refreshTimer = setInterval(async () => {
			const prevLen = promoImages.length;
			await loadPromos();
			// reiniciar autoplay si cambiÃ³ el nÃºmero de imÃ¡genes
			if(promoImages.length !== prevLen){ startAutoplay(); }
		}, 30000);
	}
	function stopRefresh(){ if(refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; } }

	// arrancar timers
	startAutoplay();
	startRefresh();

	// limpiar al salir
	window.addEventListener('beforeunload', () => { stopAutoplay(); stopRefresh(); });
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
		// Swap visual icon for close/open and prevent body scroll when open.
		// Use unicode escapes to avoid mojibake in environments with wrong encoding.
		menuToggle.textContent = now ? '\u2715' : '\u2630';
		document.body.classList.toggle('nav-open', now);
	});

	// Ensure menu closes when resizing to desktop widths
	window.addEventListener('resize', () => {
		if (window.innerWidth > 900 && nav.classList.contains('open')) {
			nav.classList.remove('open');
			menuToggle.setAttribute('aria-expanded','false');
			menuToggle.textContent = '\u2630';
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
			if (nav.classList.contains('open')) {
				nav.classList.remove('open');
				document.body.classList.remove('nav-open');
				if(menuToggle){
					menuToggle.setAttribute('aria-expanded','false');
					menuToggle.textContent = '\u2630';
				}
			}
		}
	});
});

// Ensure mailto links reliably open (fallback if another handler prevents default)
document.addEventListener('click', (e) => {
	const mail = e.target && e.target.closest ? e.target.closest('a[href^="mailto:"]') : null;
	if (!mail) return;
	// Open Gmail composer preserving subject/body.
	// Only inject the CV template for CV-related links.
	try {
		e.preventDefault();
		e.stopPropagation();
		const href = mail.getAttribute('href') || '';
		// parse mailto:to?subject=...&body=...
		let to = '';
		let params = '';
		if (href.startsWith('mailto:')){
			const rest = href.slice(7);
			const parts = rest.split('?');
			to = parts[0] || '';
			params = parts[1] || '';
		}
		const usp = new URLSearchParams(params);
		const subject = usp.get('subject') || '';
		const body = usp.get('body') || '';
		const intentText = (
			String(subject || '') + ' ' +
			String(body || '') + ' ' +
			String(mail.getAttribute('data-mail-intent') || '') + ' ' +
			String(mail.textContent || '')
		).toLowerCase();
		const isCvIntent = /(?:\bcv\b|curriculum|trabaj)/i.test(intentText);
		const professionalBody = isCvIntent
			? (
				(body ? body + '\n\n' : '') +
				'Estimado/a equipo de DistriAr,\n\n' +
				'Adjunto mi curriculum vitae para postularme a oportunidades laborales en su empresa.\n' +
				'Quedo a disposicion para brindar mas informacion y coordinar una entrevista si asi lo consideran oportuno.\n\n' +
				'Atentamente,\n' +
				'[Nombre y Apellido]\n' +
				'[Telefono]\n\n' +
				'Por favor adjunte su CV a este correo antes de enviarlo.'
			)
			: body;
		const gmailUrl = 'https://mail.google.com/mail/?view=cm&fs=1' +
			(to ? '&to=' + encodeURIComponent(to) : '') +
			(subject ? '&su=' + encodeURIComponent(subject) : '') +
			'&body=' + encodeURIComponent(professionalBody || '');
		// Open Gmail composer in a new tab/window. If popup blocked, fallback to mailto navigation.
		const w = window.open(gmailUrl, '_blank');
		if (!w) {
			window.location.href = href; // fallback to default mail client
		}
	} catch (err) {
		// fallback: navigate to mailto if anything fails
		try { window.location.href = mail.href; } catch(e){}
	}
});

// Scroll reveal for cards and sections
const observer = new IntersectionObserver((entries) => {
	entries.forEach(entry => {
		if(entry.isIntersecting){
			entry.target.classList.add('in-view');
		}
	});
},{threshold: 0.15});
document.querySelectorAll('.card, .log-card, .about-text, .about-values, .product-card, .hero-text, .hero-order-card, .shortcut-card').forEach(el => {
	observer.observe(el);
});

