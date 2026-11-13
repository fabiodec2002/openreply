import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { relayDmWebhook } from "../lib/meta/dm-relay";

const RELAY_URL = "https://studio.example.com/api/meta/webhook";
const SIGNATURE = "sha256=abc123";

const dmBody = JSON.stringify({
  object: "instagram",
  entry: [
    {
      id: "17841400000000000",
      time: 1,
      messaging: [
        {
          sender: { id: "1" },
          recipient: { id: "2" },
          timestamp: 1,
          message: { mid: "m1", text: "hi" },
        },
      ],
    },
  ],
});

const echoBody = JSON.stringify({
  object: "instagram",
  entry: [
    {
      id: "17841400000000000",
      time: 1,
      messaging: [
        {
          sender: { id: "2" },
          recipient: { id: "1" },
          timestamp: 1,
          message: { mid: "m2", is_echo: true, attachments: [] },
        },
      ],
    },
  ],
});

const standbyBody = JSON.stringify({
  object: "instagram",
  entry: [
    {
      id: "17841400000000000",
      time: 1,
      standby: [
        {
          sender: { id: "1" },
          recipient: { id: "2" },
          timestamp: 1,
          message: { mid: "m3", text: "hi" },
        },
      ],
    },
  ],
});

const commentBody = JSON.stringify({
  object: "instagram",
  entry: [
    {
      id: "17841400000000000",
      time: 1,
      changes: [{ field: "comments", value: { id: "c1", text: "roadmap" } }],
    },
  ],
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("DM_RELAY_URL", RELAY_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("relayDmWebhook", () => {
  it("relays a DM event to DM_RELAY_URL with the exact body and signature header", async () => {
    await relayDmWebhook(dmBody, SIGNATURE, JSON.parse(dmBody));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RELAY_URL);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(dmBody);
    const headers = new Headers(init.headers);
    expect(headers.get("x-hub-signature-256")).toBe(SIGNATURE);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("relays an echo or standby event too", async () => {
    await relayDmWebhook(echoBody, SIGNATURE, JSON.parse(echoBody));
    await relayDmWebhook(standbyBody, SIGNATURE, JSON.parse(standbyBody));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(echoBody);
    expect(fetchMock.mock.calls[1][1].body).toBe(standbyBody);
  });

  it("does not relay a comment-only event", async () => {
    await relayDmWebhook(commentBody, SIGNATURE, JSON.parse(commentBody));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when DM_RELAY_URL is unset", async () => {
    vi.stubEnv("DM_RELAY_URL", "");

    await relayDmWebhook(dmBody, SIGNATURE, JSON.parse(dmBody));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a relay that rejects or times out never throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      relayDmWebhook(dmBody, SIGNATURE, JSON.parse(dmBody))
    ).resolves.toBeUndefined();

    fetchMock.mockRejectedValueOnce(
      new DOMException("The operation was aborted.", "TimeoutError")
    );
    await expect(
      relayDmWebhook(dmBody, SIGNATURE, JSON.parse(dmBody))
    ).resolves.toBeUndefined();

    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
