// Forwards Instagram DM webhook bodies to a second receiver (the ClarityCraft
// Studio). Meta lets an app have one callback URL, so the Studio reuses this
// app's delivery instead of its own. The body and Meta's signature header are
// passed on byte-for-byte, so the receiver verifies them with this app's secret.

type WebhookEntry = { messaging?: unknown; standby?: unknown };

function hasDmEvent(payload: unknown): boolean {
  const entries = (payload as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return false;
  return entries.some(
    (e: WebhookEntry) => Array.isArray(e?.messaging) || Array.isArray(e?.standby)
  );
}

export async function relayDmWebhook(
  rawBody: string,
  signature: string | null,
  payload: unknown
): Promise<void> {
  const url = process.env.DM_RELAY_URL;
  if (!url || !signature || !hasDmEvent(payload)) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // The relay is best-effort: OpenReply's own handling must never depend on it.
  }
}
