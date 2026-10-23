import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase as firebaseGetDatabase } from "firebase-admin/database";
import webpush from "web-push";

export const ROUTES = {
  config: "/.netlify/functions/push-config",
  register: "/.netlify/functions/push-register",
  action: "/.netlify/functions/push-action",
  test: "/.netlify/functions/push-test"
};

export function response(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("El cuerpo de la solicitud no es JSON válido."), { status: 400 });
  }
}

export function requireMethod(request, method) {
  if (request.method !== method) {
    throw Object.assign(new Error("Método no permitido."), { status: 405 });
  }
}

function ensureAdminApp() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !process.env.FIREBASE_DATABASE_URL) {
    throw Object.assign(new Error("Falta configurar el acceso privado a Firebase en Netlify."), { status: 503 });
  }
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw Object.assign(new Error("La credencial privada de Firebase no tiene formato JSON válido."), { status: 500 });
    }
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
}

export function getDatabase() {
  ensureAdminApp();
  return firebaseGetDatabase();
}

export function getWebPush() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    throw Object.assign(new Error("Falta configurar las claves VAPID de notificaciones en Netlify."), { status: 503 });
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return webpush;
}

export async function notificationIcon() {
  const primary = process.env.PUSH_ICON_URL
    || "https://i.ibb.co/JFrnTqWc/c4497cf0-2f10-43bf-b5ac-6c232c4d0e18.jpg";
  const fallback = process.env.PUSH_ICON_FALLBACK_URL
    || `${process.env.URL || "https://barbershopjames.netlify.app"}/logojames.jpg`;
  for (const candidate of [primary, fallback]) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:") continue;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      let result;
      try {
        result = await fetch(url, { method: "GET", signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const isImage = (result.headers.get("content-type") || "").startsWith("image/");
      if (result.ok && isImage) {
        if (result.body) await result.body.cancel();
        return url.href;
      }
      if (result.body) await result.body.cancel();
    } catch (error) {
      console.warn("No se pudo validar el logo de notificación:", candidate, error.message);
    }
  }
  return primary;
}

export function signingSecret() {
  const secret = process.env.PUSH_SIGNING_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw Object.assign(new Error("La clave privada de notificaciones no está configurada correctamente."), { status: 503 });
  }
  return secret;
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export function signManagementToken(data) {
  const encoded = toBase64Url(JSON.stringify(data));
  const signature = createHmac("sha256", signingSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyManagementToken(token) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = createHmac("sha256", signingSecret()).update(parts[0]).digest();
  let actual;
  try {
    actual = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload
      || typeof payload.reservationId !== "string"
      || !/^[A-Za-z0-9_-]{10,128}$/.test(payload.reservationId)
      || typeof payload.ownerUid !== "string"
      || typeof payload.subscriptionHash !== "string"
      || !/^[a-f0-9]{64}$/.test(payload.subscriptionHash)
      || !Number.isFinite(Number(payload.expiresAt))
      || Number(payload.expiresAt) <= Date.now()) return null;
  return payload;
}

export function signQueueEntry(key, item) {
  return createHmac("sha256", signingSecret())
    .update(`${key}|${item.reservationId}|${item.ownerUid}|${item.subscriptionHash}|${item.stage}|${item.scheduledAt}|${Number(item.attempts || 0)}`)
    .digest("base64url");
}

export function verifyQueueEntry(key, item) {
  if (!item || typeof item.signature !== "string"
      || !Number.isInteger(item.attempts)
      || item.attempts < 0
      || item.attempts > 2
      || !Number.isFinite(item.scheduledAt)) return false;
  const expected = Buffer.from(signQueueEntry(key, item));
  const actual = Buffer.from(item.signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function subscriptionHash(subscription) {
  return createHash("sha256").update(subscription.endpoint).digest("hex");
}

export function encryptSubscription(subscription) {
  const key = createHash("sha256").update(signingSecret()).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(subscription), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url")
  };
}

export function decryptSubscription(value) {
  const key = createHash("sha256").update(signingSecret()).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(value.data, "base64url")),
    decipher.final()
  ]).toString("utf8");
  return JSON.parse(plain);
}

export async function verifyFirebaseUser(request) {
  ensureAdminApp();
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw Object.assign(new Error("Inicia sesión para activar estos avisos."), { status: 401 });
  const decoded = await getAuth().verifyIdToken(match[1]);
  return decoded;
}

export async function verifyDeveloper(request) {
  const user = await verifyFirebaseUser(request);
  const allowedUid = process.env.PUSH_DEVELOPER_UID;
  if (!allowedUid || user.uid !== allowedUid || user.firebase?.sign_in_provider !== "password") {
    throw Object.assign(new Error("Esta cuenta no tiene acceso a la prueba de desarrollador."), { status: 403 });
  }
  return user;
}

export function validateSubscription(subscription) {
  let endpoint;
  try {
    endpoint = new URL(subscription?.endpoint);
  } catch {
    throw Object.assign(new Error("La suscripción del navegador no es válida."), { status: 400 });
  }
  const host = endpoint.hostname.toLowerCase();
  const approvedPushService = endpoint.protocol === "https:"
    && !endpoint.username
    && !endpoint.password
    && (!endpoint.port || endpoint.port === "443")
    && (
      host === "fcm.googleapis.com"
      || host.endsWith(".fcm.googleapis.com")
      || host === "push.services.mozilla.com"
      || host.endsWith(".push.services.mozilla.com")
      || host === "web.push.apple.com"
    );
  if (!subscription || typeof subscription.endpoint !== "string"
      || !approvedPushService
      || typeof subscription.keys?.p256dh !== "string"
      || typeof subscription.keys?.auth !== "string"
      || subscription.endpoint.length > 4096
      || subscription.keys.p256dh.length > 256
      || subscription.keys.auth.length > 256) {
    throw Object.assign(new Error("La suscripción del navegador no es válida."), { status: 400 });
  }
}

export function appointmentTimestamp(fecha, hora) {
  const matchDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fecha || ""));
  const matchTime = /^(\d{2}):(\d{2})$/.exec(String(hora || ""));
  if (!matchDate || !matchTime) {
    throw Object.assign(new Error("La fecha u hora de la reserva no es válida."), { status: 400 });
  }
  const [, year, month, day] = matchDate.map(Number);
  const [, hour, minute] = matchTime.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw Object.assign(new Error("La fecha u hora de la reserva no es válida."), { status: 400 });
  }
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  let candidate = targetUtc;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    candidate += targetUtc - localAsUtc;
  }
  const check = Object.fromEntries(formatter.formatToParts(new Date(candidate))
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  if (check.year !== year || check.month !== month || check.day !== day
      || check.hour !== hour || check.minute !== minute) {
    throw Object.assign(new Error("No se pudo interpretar la fecha de la reserva en Chile."), { status: 400 });
  }
  return candidate;
}

export function safeError(error) {
  const status = Number(error?.status);
  return response(status >= 400 && status < 600 ? status : 500, {
    error: status >= 400 && status < 600 ? error.message : "No se pudo completar la operación."
  });
}
