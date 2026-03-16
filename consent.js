// Simple cookie consent manager (no external deps)
(function(){
  const CONSENT_KEY = 'site:cookie_consent_v1';
  const DEFAULT_CONSENT = { necessary: true, analytics: false, marketing: false };

  function readConsent(){
    try{
      const raw = localStorage.getItem(CONSENT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return Object.assign({}, DEFAULT_CONSENT, parsed);
    }catch(_){ return null; }
  }

  function saveConsent(consent){
    try{
      const payload = Object.assign({
        necessary: true,
        analytics: !!consent.analytics,
        marketing: !!consent.marketing,
        ts: Date.now()
      }, consent || {});
      localStorage.setItem(CONSENT_KEY, JSON.stringify(payload));
      document.documentElement.dataset.cookieConsent = payload.analytics || payload.marketing ? 'full' : 'essential';
      document.dispatchEvent(new CustomEvent('cookie:consent', { detail: payload }));
    }catch(_){ }
  }

  function ensureBanner(){
    if (document.getElementById('cookieBanner')) return;
    const banner = document.createElement('div');
    banner.id = 'cookieBanner';
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML = `
      <div class="cookie-copy">
        <h4>Preferencias de cookies</h4>
        <p>Usamos cookies necesarias para que el sitio funcione y opcionales para analíticas. Podés aceptar todo o elegir qué permitir.</p>
      </div>
      <div class="cookie-actions">
        <button class="btn btn-primary" id="cookieAcceptAll" type="button">Aceptar todo</button>
        <button class="btn btn-ghost" id="cookieReject" type="button">Rechazar opcionales</button>
        <button class="btn" id="cookieConfig" type="button">Configurar</button>
      </div>
      <div class="cookie-settings" id="cookieSettings">
        <label class="cookie-toggle">
          <input type="checkbox" checked disabled />
          Necesarias (siempre activas)
        </label>
        <label class="cookie-toggle">
          <input type="checkbox" id="cookieAnalytics" />
          Analíticas
        </label>
        <label class="cookie-toggle">
          <input type="checkbox" id="cookieMarketing" />
          Marketing
        </label>
        <div class="cookie-actions">
          <button class="btn btn-primary" id="cookieSave" type="button">Guardar preferencias</button>
        </div>
      </div>
    `;
    document.body.appendChild(banner);

    const settings = banner.querySelector('#cookieSettings');
    const btnConfig = banner.querySelector('#cookieConfig');
    const btnAccept = banner.querySelector('#cookieAcceptAll');
    const btnReject = banner.querySelector('#cookieReject');
    const btnSave = banner.querySelector('#cookieSave');
    const analyticsToggle = banner.querySelector('#cookieAnalytics');
    const marketingToggle = banner.querySelector('#cookieMarketing');

    btnConfig.addEventListener('click', () => {
      settings.classList.toggle('open');
    });

    btnAccept.addEventListener('click', () => {
      saveConsent({ analytics: true, marketing: true });
      banner.remove();
    });

    btnReject.addEventListener('click', () => {
      saveConsent({ analytics: false, marketing: false });
      banner.remove();
    });

    btnSave.addEventListener('click', () => {
      saveConsent({ analytics: !!analyticsToggle.checked, marketing: !!marketingToggle.checked });
      banner.remove();
    });
  }

  function openSettings(){
    const existing = document.getElementById('cookieBanner');
    if (existing) {
      const settings = existing.querySelector('#cookieSettings');
      if (settings) settings.classList.add('open');
      return;
    }
    ensureBanner();
    const created = document.getElementById('cookieBanner');
    const settings = created && created.querySelector('#cookieSettings');
    if (settings) settings.classList.add('open');
  }

  function init(){
    const consent = readConsent();
    if (!consent) {
      ensureBanner();
    } else {
      document.documentElement.dataset.cookieConsent = consent.analytics || consent.marketing ? 'full' : 'essential';
    }

    document.querySelectorAll('.cookie-settings-link').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        openSettings();
      });
    });

    window.openCookieSettings = openSettings;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
