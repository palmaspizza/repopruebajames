import {
  appointmentTimestamp,
  decryptSubscription,
  getDatabase,
  getWebPush,
  notificationIcon,
  response,
  safeError,
  signManagementToken,
  signQueueEntry,
  verifyQueueEntry
} from "./_push-shared.mjs";

export const config = { schedule: "*/15 * * * *" };

export default async function handler() {
  try {
    const database = getDatabase();
    const now = Date.now();
    const due = await database.ref("webpush/queue")
      .orderByChild("scheduledAt")
      .endAt(now)
      .limitToFirst(50)
      .once("value");
    const records = [];
    due.forEach(child => records.push({ key: child.key, item: child.val() }));
    if (!records.length) {
      return response(200, { ok: true, sent: 0, removed: 0, checked: 0 });
    }

    const sender = getWebPush();
    const icon = await notificationIcon();
    let sent = 0;
    let removed = 0;
    const errors = [];
    for (const record of records) {
      const { key, item } = record;
      const reservationId = item?.reservationId;
      const subscriptionHash = item?.subscriptionHash;
      if (!verifyQueueEntry(key, item)) {
        await database.ref(`webpush/queue/${key}`).remove();
        removed++;
        continue;
      }

      const reservationSnapshot = await database.ref(`reservas/${reservationId}`).once("value");
      const reservation = reservationSnapshot.val();
      if (!reservation || reservation.ownerUid !== item.ownerUid) {
        await database.ref(`webpush/queue/${key}`).remove();
        removed++;
        continue;
      }
      if (reservation.clienteConfirmacion === "asistire") {
        await database.ref(`webpush/queue/${key}`).remove();
        removed++;
        continue;
      }

      let appointmentAt;
      try {
        appointmentAt = appointmentTimestamp(reservation.fecha, reservation.hora);
      } catch (error) {
        console.error("Reserva con fecha no válida; se descarta su aviso:", reservationId, error);
        await database.ref(`webpush/queue/${key}`).remove();
        removed++;
        continue;
      }
      if (appointmentAt <= now) {
        await database.ref(`webpush/queue/${key}`).remove();
        removed++;
        continue;
      }

      const stageDelay = item.stage === "24h"
        ? 24 * 60 * 60 * 1000
        : item.stage === "3h"
          ? 3 * 60 * 60 * 1000
          : null;
      if (stageDelay === null) {
        await database.ref(`webpush/queue/${key}`).remove();
        removed++;
        continue;
      }
      const expectedAt = appointmentAt - stageDelay;
      if (item.scheduledAt !== expectedAt) {
        if (expectedAt > now) {
          const updated = { ...item, scheduledAt: expectedAt };
          updated.signature = signQueueEntry(key, updated);
          await database.ref(`webpush/queue/${key}`).set(updated);
        } else {
          await database.ref(`webpush/queue/${key}`).remove();
          removed++;
        }
        continue;
      }

      const subscriptionSnapshot = await database.ref(`webpush/subscriptions/${subscriptionHash}`).once("value");
      const stored = subscriptionSnapshot.val();
      if (!stored || stored.ownerUid !== item.ownerUid) {
        await database.ref(`webpush/queue/${key}`).remove();
        removed++;
        continue;
      }

      const token = signManagementToken({
        reservationId,
        ownerUid: item.ownerUid,
        subscriptionHash,
        expiresAt: appointmentAt + 6 * 60 * 60 * 1000
      });
      const fecha = new Date(appointmentAt).toLocaleDateString("es-CL", {
        timeZone: "America/Santiago",
        day: "numeric",
        month: "long"
      });
      const payload = JSON.stringify({
        title: "James Barbershop",
        body: `Tienes una reserva el ${fecha} a las ${reservation.hora}. Confirma o cambia tu hora.`,
        icon,
        badge: icon,
        tag: `reserva-${reservationId}`,
        data: { url: `/gestionar-reserva.html#t=${encodeURIComponent(token)}` }
      });

      try {
        await sender.sendNotification(decryptSubscription(stored.encrypted), payload, { TTL: 60 * 60 * 24 });
        await database.ref(`webpush/queue/${key}`).remove();
        sent++;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await database.ref(`webpush/subscriptions/${subscriptionHash}`).remove();
          await database.ref(`webpush/queue/${key}`).remove();
          removed++;
        } else {
          const attempts = Number(item.attempts || 0);
          if (attempts >= 2) {
            await database.ref(`webpush/queue/${key}`).remove();
            removed++;
          } else {
            const retry = {
              ...item,
              attempts: attempts + 1,
              scheduledAt: Date.now() + 15 * 60 * 1000
            };
            retry.signature = signQueueEntry(key, retry);
            await database.ref(`webpush/queue/${key}`).set(retry);
          }
          errors.push(`${key}: ${error.statusCode || error.name || "send failed"}`);
        }
      }
    }

    if (errors.length) {
      console.error("Fallos al enviar recordatorios:", errors);
      return response(500, { ok: false, sent, removed, errors: errors.length });
    }
    return response(200, { ok: true, sent, removed, checked: due.numChildren() });
  } catch (error) {
    console.error("push-dispatch:", error);
    return safeError(error);
  }
}
