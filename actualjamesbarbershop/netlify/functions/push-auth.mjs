import { response, safeError, verifyDeveloper } from "./_push-shared.mjs";

export default async function handler(request) {
  try {
    if (request.method !== "POST") return response(405, { error: "Método no permitido." });
    const user = await verifyDeveloper(request);
    return response(200, { ok: true, uid: user.uid });
  } catch (error) {
    console.error("push-auth:", error);
    return safeError(error);
  }
}
