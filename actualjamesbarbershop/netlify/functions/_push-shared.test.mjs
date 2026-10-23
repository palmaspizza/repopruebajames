import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appointmentTimestamp,
  decryptSubscription,
  encryptSubscription,
  signManagementToken,
  signQueueEntry,
  validateSubscription,
  verifyManagementToken,
  verifyQueueEntry
} from "./_push-shared.mjs";

process.env.PUSH_SIGNING_SECRET = "test-only-secret-with-at-least-32-bytes";

test("converts appointment times to Santiago time and rejects invalid dates", () => {
  const timestamp = appointmentTimestamp("2026-04-16", "11:30");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const local = Object.fromEntries(
    parts.filter(part => part.type !== "literal").map(part => [part.type, part.value])
  );

  assert.deepEqual(
    [local.year, local.month, local.day, local.hour, local.minute],
    ["2026", "04", "16", "11", "30"]
  );
  assert.throws(() => appointmentTimestamp("2026-02-31", "11:30"));
});

test("signs management links and rejects tampering", () => {
  const data = {
    reservationId: "abcdefghij",
    ownerUid: "client-uid",
    subscriptionHash: "a".repeat(64),
    expiresAt: Date.now() + 60_000
  };
  const token = signManagementToken(data);

  assert.deepEqual(verifyManagementToken(token), data);
  assert.equal(verifyManagementToken(`${token}x`), null);
});

test("authenticates queue entries and prevents unauthorized edits", () => {
  const item = {
    reservationId: "abcdefghij",
    ownerUid: "client-uid",
    subscriptionHash: "a".repeat(64),
    stage: "24h",
    scheduledAt: Date.now() + 60_000,
    attempts: 0
  };
  item.signature = signQueueEntry("queue-key", item);

  assert.equal(verifyQueueEntry("queue-key", item), true);
  assert.equal(verifyQueueEntry("other-key", item), false);
  assert.equal(verifyQueueEntry("queue-key", { ...item, attempts: 1 }), false);
});

test("accepts browser push providers and rejects arbitrary endpoints", () => {
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/example",
    keys: { p256dh: "public-key", auth: "auth-key" }
  };

  assert.doesNotThrow(() => validateSubscription(subscription));
  assert.throws(() => validateSubscription({
    ...subscription,
    endpoint: "https://127.0.0.1/fcm/send/example"
  }));
});

test("encrypts stored push subscriptions and detects corrupted ciphertext", () => {
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/example",
    keys: { p256dh: "public-key", auth: "auth-key" }
  };
  const encrypted = encryptSubscription(subscription);

  assert.deepEqual(decryptSubscription(encrypted), subscription);
  assert.throws(() => decryptSubscription({ ...encrypted, data: "invalid" }));
});
