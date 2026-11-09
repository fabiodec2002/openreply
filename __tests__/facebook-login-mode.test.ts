import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserInfo, getUserMedia, sendDirectMessage } from "@/lib/meta/client";

const IG = "17841475244855937";
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("INSTAGRAM_LOGIN_CONFIG_ID", "cfg");
  vi.stubEnv("INSTAGRAM_ACCOUNT_ID", IG);
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  fetchMock = vi.fn(async () => ok({ id: IG, username: "founder.fabio", data: [] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const calledUrl = () => new URL(String(fetchMock.mock.calls[0][0]));

describe("Facebook Login mode", () => {
  it("uses graph.facebook.com for account calls in Facebook Login mode", async () => {
    await sendDirectMessage("tok", IG, "igsid", "hi");
    expect(calledUrl().href).toBe(`https://graph.facebook.com/v25.0/${IG}/messages`);
  });

  it("reads the profile from INSTAGRAM_ACCOUNT_ID, not /me", async () => {
    await getUserInfo("tok");
    const url = calledUrl();
    expect(url.origin + url.pathname).toBe(`https://graph.facebook.com/v25.0/${IG}`);
    expect(url.searchParams.get("fields")).not.toContain("user_id");
  });

  it("lists media from INSTAGRAM_ACCOUNT_ID/media, not /me/media", async () => {
    await getUserMedia("tok");
    const url = calledUrl();
    expect(url.origin + url.pathname).toBe(`https://graph.facebook.com/v25.0/${IG}/media`);
  });

  it("throws when INSTAGRAM_ACCOUNT_ID is missing in Facebook Login mode", async () => {
    vi.stubEnv("INSTAGRAM_ACCOUNT_ID", "");
    await expect(getUserInfo("tok")).rejects.toThrow("INSTAGRAM_ACCOUNT_ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
