// Mobile menu toggle
const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav');
if(menuToggle){
	menuToggle.addEventListener('click', () => {
		nav.classList.toggle('open');
		const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
		menuToggle.setAttribute('aria-expanded', String(!expanded));
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
document.querySelectorAll('.card, .log-card, .about-text, .about-values, .product-card').forEach(el => {
	observer.observe(el);
});

