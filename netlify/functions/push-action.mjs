import {
  appointmentTimestamp,
  getDatabase,
  readBody,
  response,
  safeError,
  verifyManagementToken
} from "./_push-shared.mjs";

function reservationLockKey(hora) {
  return String(hora || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function removeQueuedReminders(database, reservationId) {
  try {
    const snapshot = await database.ref("webpush/queue")
      .orderByChild("reservationId")
      .equalTo(reservationId)
      .once("value");
    const updates = {};
    snapshot.forEach(child => { updates[child.key] = null; });
    if (Object.keys(updates).length) await database.ref("webpush/queue").update(updates);
    return true;
  } catch (error) {
    console.error("No se pudo limpiar la cola de recordatorios:", reservationId, error);
    return false;
  }
}

async function cancelReservation(database, reservationId, reservation) {
  await database.ref(`reservas/${reservationId}`).remove();
  const lockRef = database.ref(
    `bloqueos/${reservation.fecha}/${reservationLockKey(reservation.hora)}`
  );
  let lockReleased = true;
  try {
    const result = await lockRef.transaction(current =>
      current && current.reservaId === reservationId ? null : undefined
    );
    if (!result.committed && result.snapshot.val()?.reservaId === reservationId) {
      throw new Error("El horario aún aparece bloqueado.");
    }
  } catch (error) {
    console.error("Se canceló la reserva, pero no se pudo liberar su horario:", reservationId, error);
    lockReleased = false;
  }
  return {
    lockReleased,
    remindersRemoved: await removeQueuedReminders(database, reservationId)
  };
}

export default async function handler(request) {
  try {
    if (request.method !== "GET" && request.method !== "POST") {
      return response(405, { error: "Método no permitido." });
    }
    const url = new URL(request.url);
    const body = request.method === "GET" ? null : await readBody(request);
    const token = request.method === "GET" ? url.searchParams.get("t") : body?.token;
    const access = verifyManagementToken(token);
    if (!access) throw Object.assign(new Error("Este enlace venció o no es válido."), { status: 401 });

    const database = getDatabase();
    const reservationRef = database.ref(`reservas/${access.reservationId}`);
    const snapshot = await reservationRef.once("value");
    const reservation = snapshot.val();
    if (!reservation || reservation.ownerUid !== access.ownerUid) {
      throw Object.assign(new Error("No encontré una reserva activa asociada a este enlace."), { status: 404 });
    }

    if (request.method === "GET" || body.action === "load") {
      return response(200, {
        ok: true,
        reservation: {
          fecha: reservation.fecha,
          hora: reservation.hora,
          servicios: reservation.servicios || reservation.servicio || "",
          nombre: reservation.nombre || ""
        }
      });
    }
    if (request.method !== "POST") return response(405, { error: "Método no permitido." });
    const currentAppointmentAt = appointmentTimestamp(reservation.fecha, reservation.hora);
    if (currentAppointmentAt <= Date.now()) {
      throw Object.assign(new Error("Esta hora ya pasó y no se puede cambiar desde este enlace."), { status: 409 });
    }

    if (body.action === "attend") {
      await reservationRef.update({
        clienteConfirmacion: "asistire",
        clienteConfirmacionAt: Date.now()
      });
      const remindersRemoved = await removeQueuedReminders(database, access.reservationId);
      return response(200, {
        ok: true,
        message: remindersRemoved
          ? "Gracias por confirmar. Te esperamos."
          : "Tu confirmación quedó guardada. Los avisos pendientes se descartarán automáticamente."
      });
    }

    if (body.action === "cancel") {
      const cleanup = await cancelReservation(database, access.reservationId, reservation);
      const details = [
        cleanup.lockReleased ? null : "La barbería deberá liberar el horario manualmente.",
        cleanup.remindersRemoved ? null : "Los avisos pendientes se descartarán automáticamente."
      ].filter(Boolean);
      return response(200, {
        ok: true,
        message: ["Reserva cancelada.", ...details].join(" ")
      });
    }

    if (body.action === "rescheduled") {
      const newId = String(body.newReservationId || "");
      if (!/^[A-Za-z0-9_-]{10,128}$/.test(newId)) {
        throw Object.assign(new Error("No se pudo validar la nueva reserva; la anterior sigue activa."), { status: 400 });
      }
      if (newId === access.reservationId) {
        throw Object.assign(new Error("La nueva reserva debe ser distinta de la anterior."), { status: 400 });
      }
      const nextSnapshot = await database.ref(`reservas/${newId}`).once("value");
      const nextReservation = nextSnapshot.val();
      if (!nextReservation || nextReservation.ownerUid !== access.ownerUid) {
        throw Object.assign(new Error("No pude verificar la nueva reserva; la anterior sigue activa."), { status: 403 });
      }
      if (appointmentTimestamp(nextReservation.fecha, nextReservation.hora) <= Date.now()) {
        throw Object.assign(new Error("La nueva hora ya pasó; la reserva anterior sigue activa."), { status: 400 });
      }
      const cleanup = await cancelReservation(database, access.reservationId, reservation);
      const details = [
        cleanup.lockReleased ? null : "La barbería deberá liberar el horario anterior manualmente.",
        cleanup.remindersRemoved ? null : "Los avisos anteriores se descartarán automáticamente."
      ].filter(Boolean);
      return response(200, {
        ok: true,
        message: ["La nueva hora quedó confirmada y la reserva anterior se canceló.", ...details].join(" ")
      });
    }

    throw Object.assign(new Error("Acción no reconocida."), { status: 400 });
  } catch (error) {
    console.error("push-action:", error);
    return safeError(error);
  }
}
