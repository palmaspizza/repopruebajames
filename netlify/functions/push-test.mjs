import {
  getWebPush,
  notificationIcon,
  readBody,
  response,
  safeError,
  validateSubscription,
  verifyDeveloper
} from "./_push-shared.mjs";

export default async function handler(request) {
  try {
    if (request.method !== "POST") return response(405, { error: "Método no permitido." });
    await verifyDeveloper(request);
    const body = await readBody(request);
    validateSubscription(body.subscription);
    const icon = await notificationIcon();
    await getWebPush().sendNotification(body.subscription, JSON.stringify({
      title: "James Barbershop",
      body: "Prueba de notificaciones lista. Este teléfono puede recibir recordatorios de reservas.",
      icon,
      badge: icon,
      tag: "jb-prueba-desarrollador",
      data: { url: "/" }
    }), { TTL: 60 });
    return response(200, { ok: true, message: "Prueba enviada a este dispositivo." });
  } catch (error) {
    console.error("push-test:", error);
    return safeError(error);
  }
}
