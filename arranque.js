  // cualquier error queda a la vista: la pagina no puede quedarse muda
  window.__alerta = (t) => {
    const d = document.getElementById('alerta');
    if (!d) return;
    d.textContent = t;
    d.classList.remove('oculto');
  };
  window.addEventListener('error', (e) => window.__alerta(
    'Error: ' + (e.message || e.type) + (e.filename ? ' — ' + e.filename : '')));
  window.addEventListener('unhandledrejection', (e) => window.__alerta(
    'Error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));
