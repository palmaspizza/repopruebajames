(function () {
  'use strict';

  let config = null;
  let developerAuthorized = false;
  let subscription = null;

  function setStatus(message, isError) {
    const status = document.getElementById('jbPushDeveloperStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#ff989e' : '#f1c887';
  }

  async function getConfig() {
    if (config) return config;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response;
    try {
      response = await fetch('/.netlify/functions/push-config', {
        cache: 'no-store',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error('No se pudo consultar la configuración de Netlify.');
    config = await response.json();
    return config;
  }

  function base64ToBytes(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  }

  async function authorizeAccount() {
    developerAuthorized = false;
    const email = document.getElementById('jbPushDevEmail').value.trim();
    const password = document.getElementById('jbPushDevPassword').value;
    if (!email || !password) throw new Error('Escribe el correo y la contraseña de desarrollador.');
    const auth = firebase.auth();
    let user = auth.currentUser;
    if (!user || user.email !== email) {
      const credential = await auth.signInWithEmailAndPassword(email, password);
      user = credential.user;
    }
    const idToken = await user.getIdToken(true);
    const response = await fetch('/.netlify/functions/push-auth', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Esta cuenta no tiene permiso de desarrollador.');
    developerAuthorized = true;
    return user;
  }

  async function getSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)
        || !('Notification' in window) || location.protocol !== 'https:') {
      throw new Error('Abre el sitio por HTTPS en Android o escritorio compatible. iPhone/iPad queda excluido.');
    }
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      throw new Error('Las notificaciones push están desactivadas en iPhone/iPad.');
    }
    const settings = await getConfig();
    if (!settings.enabled || !settings.vapidPublicKey) {
      throw new Error('Faltan configurar las variables privadas de notificaciones en Netlify.');
    }
    if (Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('No se concedió permiso de notificaciones en el navegador.');
    }
    await navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
    const registration = await navigator.serviceWorker.ready;
    const current = await registration.pushManager.getSubscription();
    subscription = current || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64ToBytes(settings.vapidPublicKey)
    });
    return subscription;
  }

  async function sendTest() {
    if (!developerAuthorized) await authorizeAccount();
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Vuelve a validar la cuenta de desarrollador.');
    const idToken = await user.getIdToken();
    if (!subscription) subscription = await getSubscription();
    if (!subscription) throw new Error('Primero activa las notificaciones en este dispositivo.');
    const response = await fetch('/.netlify/functions/push-test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo enviar la prueba.');
    setStatus('Prueba enviada. Revisa las notificaciones de este dispositivo.');
  }

  function bind() {
    if (!document.getElementById('jbPushDeveloper')) return;
    document.getElementById('jbPushDevLogin').addEventListener('click', async () => {
      setStatus('Validando cuenta…');
      try {
        await authorizeAccount();
        document.getElementById('jbPushTestSend').disabled = false;
        setStatus('Cuenta autorizada. Activa los avisos en este dispositivo y envía la prueba.');
      } catch (error) {
        console.error('No se pudo validar la cuenta de desarrollador:', error);
        setStatus(error.message, true);
      }
    });
    document.getElementById('jbPushDeviceEnable').addEventListener('click', async () => {
      setStatus('Solicitando permiso de notificaciones…');
      try {
        await getSubscription();
        setStatus('Este dispositivo quedó suscrito. Ya puedes enviarte una prueba.');
        if (developerAuthorized) document.getElementById('jbPushTestSend').disabled = false;
      } catch (error) {
        console.error('No se pudo activar este dispositivo:', error);
        setStatus(error.message, true);
      }
    });
    document.getElementById('jbPushTestSend').addEventListener('click', async () => {
      const button = document.getElementById('jbPushTestSend');
      button.disabled = true;
      setStatus('Enviando notificación de prueba…');
      try {
        await sendTest();
      } catch (error) {
        console.error('Falló la prueba de notificaciones:', error);
        setStatus(error.message, true);
      } finally {
        button.disabled = !developerAuthorized;
      }
    });
    getConfig().then(settings => {
      if (!settings.enabled) setStatus('Aún no está configurado; el panel y las reservas siguen funcionando normalmente.');
      else setStatus('Preparado. Valida tu cuenta, activa este dispositivo y prueba la notificación.');
    }).catch(error => {
      setStatus(`${error.message} Si abres el archivo local, esto es esperado.`, true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
