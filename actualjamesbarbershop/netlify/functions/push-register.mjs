import {
  appointmentTimestamp,
  encryptSubscription,
  getDatabase,
  readBody,
  requireMethod,
  response,
  safeError,
  signQueueEntry,
  subscriptionHash,
  validateSubscription,
  verifyFirebaseUser
} from "./_push-shared.mjs";

export default async function handler(request) {
  try {
    requireMethod(request, "POST");
    const user = await verifyFirebaseUser(request);
    if (user.firebase?.sign_in_provider !== "anonymous") {
      throw Object.assign(new Error("Esta suscripción debe registrarse desde la sesión del cliente."), { status: 403 });
    }
    const body = await readBody(request);
    validateSubscription(body.subscription);
    const reservationId = String(body.reservationId || "");
    if (!/^[A-Za-z0-9_-]{10,128}$/.test(reservationId)) {
      throw Object.assign(new Error("No se encontró una reserva válida para asociar los avisos."), { status: 400 });
    }

    const database = getDatabase();
    const reservationRef = database.ref(`reservas/${reservationId}`);
    const snapshot = await reservationRef.once("value");
    const reservation = snapshot.val();
    if (!reservation || reservation.ownerUid !== user.uid) {
      throw Object.assign(new Error("No se pudo verificar que esta reserva pertenece a este dispositivo."), { status: 403 });
    }

    const appointmentAt = appointmentTimestamp(reservation.fecha, reservation.hora);
    if (appointmentAt <= Date.now()) {
      throw Object.assign(new Error("La reserva ya pasó; no se programaron avisos."), { status: 409 });
    }

    const hash = subscriptionHash(body.subscription);
    const subscriptionRef = database.ref(`webpush/subscriptions/${hash}`);
    await subscriptionRef.set({
      encrypted: encryptSubscription(body.subscription),
      ownerUid: user.uid,
      updatedAt: Date.now()
    });

    const queueRef = database.ref("webpush/queue");
    const stages = [
      { name: "24h", scheduledAt: appointmentAt - 24 * 60 * 60 * 1000 },
      { name: "3h", scheduledAt: appointmentAt - 3 * 60 * 60 * 1000 }
    ].filter(stage => stage.scheduledAt > Date.now());
    const existing = await queueRef.orderByChild("reservationId").equalTo(reservationId).once("value");
    const updates = {};
    existing.forEach(child => {
      if (child.val()?.subscriptionHash === hash) updates[child.key] = null;
    });
    stages.forEach(stage => {
      const key = `${reservationId}_${hash.slice(0, 20)}_${stage.name}`;
      const item = {
        reservationId,
        ownerUid: user.uid,
        subscriptionHash: hash,
        stage: stage.name,
        scheduledAt: stage.scheduledAt,
        attempts: 0
      };
      item.signature = signQueueEntry(key, item);
      updates[key] = item;
    });
    if (Object.keys(updates).length) await queueRef.update(updates);
    return response(200, { ok: true, scheduled: stages.length });
  } catch (error) {
    console.error("push-register:", error);
    return safeError(error);
  }
}
