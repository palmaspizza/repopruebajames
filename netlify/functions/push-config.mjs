import { response } from "./_push-shared.mjs";

export default async function handler(request) {
  if (request.method !== "GET") return response(405, { error: "Método no permitido." });
  const configured = Boolean(
    process.env.VAPID_PUBLIC_KEY
    && process.env.VAPID_PRIVATE_KEY
    && process.env.VAPID_SUBJECT
    && process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    && process.env.FIREBASE_DATABASE_URL
    && process.env.PUSH_SIGNING_SECRET
  );
  return response(200, {
    enabled: configured,
    vapidPublicKey: configured ? process.env.VAPID_PUBLIC_KEY : null
  });
}
