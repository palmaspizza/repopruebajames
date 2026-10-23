(function () {
  'use strict';

  const INTENTOS_MAXIMOS = 3;
  const CLAVE_INTENTOS = 'jbPushInvitaciones';
  const CLAVE_REAGENDAR = 'jbPushReagendarToken';
  let configuracion = null;
  let registroSW = null;
  let reservaPendiente = null;

  function esIOS() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function esNavegadorCompatible() {
    return !esIOS()
      && location.protocol === 'https:'
      && 'Notification' in window
      && 'serviceWorker' in navigator
      && 'PushManager' in window;
  }

  async function leerConfiguracion() {
    if (configuracion) return configuracion;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let respuesta;
    try {
      respuesta = await fetch('/.netlify/functions/push-config', {
        cache: 'no-store',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!respuesta.ok) throw new Error('No se pudo consultar la configuración de avisos.');
    configuracion = await respuesta.json();
    return configuracion;
  }

  async function registrarServiceWorker() {
    if (registroSW) return registroSW;
    registroSW = await navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    return registroSW;
  }

  function firebaseAuth() {
    if (typeof firebase === 'undefined' || typeof firebase.auth !== 'function') return null;
    return firebase.auth();
  }

  async function asegurarUsuarioAnonimo() {
    const auth = firebaseAuth();
    if (!auth) return null;
    try {
      if (auth.currentUser) return auth.currentUser;
      const credential = await auth.signInAnonymously();
      return credential.user;
    } catch (error) {
      console.error('No se pudo iniciar la sesión segura del cliente:', error);
      return null;
    }
  }

  window.jbWebPushObtenerUid = async function () {
    try {
      const config = await leerConfiguracion();
      if (!config.enabled) return null;
      const user = await asegurarUsuarioAnonimo();
      return user ? user.uid : null;
    } catch (error) {
      console.error('No se pudo preparar la cuenta de recordatorios:', error);
      return null;
    }
  };

  function convertirClave(clave) {
    const relleno = '='.repeat((4 - clave.length % 4) % 4);
    const base64 = (clave + relleno).replace(/-/g, '+').replace(/_/g, '/');
    const datos = window.atob(base64);
    return Uint8Array.from(datos, caracter => caracter.charCodeAt(0));
  }

  function mostrarAviso(reserva) {
    cerrarAviso();
    const overlay = document.createElement('div');
    overlay.id = 'jbPushPrompt';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'jbPushTitle');
    overlay.innerHTML = `
      <div class="jbPushCard">
        <button type="button" class="jbPushClose" aria-label="Cerrar">×</button>
        <div class="jbPushIcon">💈</div>
        <p class="jbPushEyebrow">JAMES BARBERSHOP</p>
        <h2 id="jbPushTitle">¿Te recordamos tu hora?</h2>
        <p class="jbPushDescription">Recibirás como máximo dos avisos antes de esta reserva. Puedes confirmar, reagendar o cancelar desde el aviso.</p>
        <div class="jbPushButtons">
          <button type="button" class="jbPushEnable">Activar recordatorios</button>
          <button type="button" class="jbPushLater">Ahora no</button>
        </div>
        <p class="jbPushStatus" aria-live="polite"></p>
        <p class="jbPushPrivacy">Solo enviaremos avisos de tus reservas. No recibirás publicidad.</p>
      </div>`;
    const style = document.createElement('style');
    style.textContent = `
      #jbPushPrompt{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:18px;background:rgba(7,8,10,.78);backdrop-filter:blur(8px);font-family:Poppins,Arial,sans-serif}
      .jbPushCard{position:relative;width:min(100%,390px);padding:27px 23px 21px;border:1px solid rgba(228,166,79,.45);border-radius:22px;background:linear-gradient(150deg,#202126,#111216);color:#f8f5ef;box-shadow:0 24px 80px rgba(0,0,0,.55);text-align:center}
      .jbPushClose{position:absolute;top:10px;right:13px;width:36px;height:36px;border:0;background:transparent;color:#bcbcc2;font-size:27px;cursor:pointer}
      .jbPushIcon{width:54px;height:54px;margin:0 auto 12px;display:grid;place-items:center;border-radius:50%;background:#33281a;font-size:25px}
      .jbPushEyebrow{margin:0;color:#e4a64f;letter-spacing:.16em;font-weight:700;font-size:.7rem}
      #jbPushTitle{margin:9px 0;font-size:1.28rem}
      .jbPushDescription{margin:0 auto 19px;max-width:310px;color:#c7c7cc;font-size:.9rem;line-height:1.55}
      .jbPushButtons{display:grid;gap:9px}
      .jbPushButtons button{min-height:48px;border-radius:12px;font:700 .91rem Poppins,Arial,sans-serif;cursor:pointer}
      .jbPushEnable{border:0;background:linear-gradient(135deg,#f1c879,#e4a64f);color:#21190d}
      .jbPushLater{border:1px solid #46474f;background:#222329;color:#eee}
      .jbPushStatus{min-height:1.2em;margin:10px 0 0;color:#f1c879;font-size:.83rem}
      .jbPushPrivacy{margin:9px 0 0;color:#96979e;font-size:.72rem;line-height:1.45}`;
    style.dataset.jbPush = '1';
    document.head.appendChild(style);
    document.body.appendChild(overlay);
    overlay.querySelector('.jbPushClose').addEventListener('click', cerrarAviso);
    overlay.querySelector('.jbPushLater').addEventListener('click', cerrarAviso);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) cerrarAviso();
    });
    overlay.querySelector('.jbPushEnable').addEventListener('click', async event => {
      const boton = event.currentTarget;
      const status = overlay.querySelector('.jbPushStatus');
      boton.disabled = true;
      status.textContent = 'Preparando tus recordatorios…';
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          cerrarAviso();
          return;
        }
        const subscription = await obtenerSuscripcion();
        await registrarReserva(reserva, subscription);
        cerrarAviso();
        mostrarConfirmacion('Listo. Te enviaremos como máximo dos recordatorios de esta reserva.');
      } catch (error) {
        console.error('No se pudieron activar los recordatorios:', error);
        status.textContent = error.message || 'No se pudieron activar ahora. La reserva sigue confirmada.';
        boton.disabled = false;
      }
    });
    overlay.querySelector('.jbPushEnable').focus();
  }

  function cerrarAviso() {
    const prompt = document.getElementById('jbPushPrompt');
    if (prompt) prompt.remove();
    const style = document.querySelector('style[data-jb-push]');
    if (style) style.remove();
  }

  function mostrarConfirmacion(texto) {
    if (typeof window.mostrarToastCliente === 'function') {
      window.mostrarToastCliente('🔔 ' + texto);
      return;
    }
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = '🔔 ' + texto;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 5000);
    }
  }

  async function obtenerSuscripcion() {
    const config = await leerConfiguracion();
    if (!config.enabled || !config.vapidPublicKey) {
      throw new Error('Los recordatorios aún no están configurados. Tu reserva sigue confirmada.');
    }
    const sw = await registrarServiceWorker();
    const existente = await sw.pushManager.getSubscription();
    return existente || sw.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertirClave(config.vapidPublicKey)
    });
  }

  async function registrarReserva(reserva, subscription) {
    const user = await asegurarUsuarioAnonimo();
    if (!user) throw new Error('No se pudo validar el dispositivo. La reserva sigue confirmada.');
    const token = await user.getIdToken();
    const respuesta = await fetch('/.netlify/functions/push-register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        reservationId: reserva.reservationId,
        subscription: subscription.toJSON()
      })
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.error || 'No se pudo guardar la suscripción.');
  }

  function puedePreguntar() {
    if (!esNavegadorCompatible() || Notification.permission !== 'default') return false;
    const intentos = Number(localStorage.getItem(CLAVE_INTENTOS) || 0);
    return intentos < INTENTOS_MAXIMOS;
  }

  async function procesarReserva(reserva) {
    if (!reserva || !reserva.reservationId || !reserva.ownerUid) return;
    try {
      const config = await leerConfiguracion();
      if (!config.enabled || !esNavegadorCompatible()) return;
      reservaPendiente = reserva;
      if (Notification.permission === 'granted') {
        const sw = await registrarServiceWorker();
        const subscription = await sw.pushManager.getSubscription();
        if (subscription) {
          await registrarReserva(reserva, subscription);
          return;
        }
      }
      if (puedePreguntar()) {
        localStorage.setItem(CLAVE_INTENTOS, String(Number(localStorage.getItem(CLAVE_INTENTOS) || 0) + 1));
        mostrarAviso(reserva);
      }
    } catch (error) {
      console.error('No se pudo preparar el recordatorio de la reserva:', error);
    }
  }

  async function completarReagendamiento(reserva) {
    const token = localStorage.getItem(CLAVE_REAGENDAR);
    if (!token || !reserva?.reservationId) return;
    try {
      const respuesta = await fetch('/.netlify/functions/push-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          action: 'rescheduled',
          newReservationId: reserva.reservationId
        })
      });
      const resultado = await respuesta.json();
      if (!respuesta.ok) throw new Error(resultado.error || 'La reserva anterior sigue activa.');
      localStorage.removeItem(CLAVE_REAGENDAR);
      const query = new URLSearchParams(location.search);
      query.delete('jbReagendar');
      history.replaceState(null, '', location.pathname + (query.toString() ? `?${query}` : '') + location.hash);
      mostrarConfirmacion(resultado.message);
    } catch (error) {
      console.error('No se pudo cerrar la reserva anterior tras reagendar:', error);
      if (typeof window.mostrarToastCliente === 'function') {
        window.mostrarToastCliente('Tu nueva reserva está lista; no pudimos cancelar la anterior. Escríbenos por WhatsApp para evitar dos horas.');
      }
    }
  }

  window.addEventListener('jb:reservation-created', event => {
    const reserva = event.detail || {};
    completarReagendamiento(reserva);
    procesarReserva(reserva);
  });

  window.addEventListener('DOMContentLoaded', async () => {
    const query = new URLSearchParams(location.search);
    const token = query.get('jbReagendar');
    if (token) localStorage.setItem(CLAVE_REAGENDAR, token);
    if (!esNavegadorCompatible()) return;
    try {
      const config = await leerConfiguracion();
      if (config.enabled) await registrarServiceWorker();
    } catch (error) {
      console.error('No se pudo inicializar Web Push:', error);
    }
  });
})();
