import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    automation: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    instagramAccount: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: () => true,
  getCurrentWorkspaceContext: vi.fn(async () => ({
    workspaceId: "workspace_123",
    role: "OWNER",
  })),
}));

vi.mock("@/lib/campaigns/links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/campaigns/links")>()),
  syncCampaignLinks: vi.fn(),
}));

import { PATCH, POST } from "../app/api/automations/route";

function request(method: "POST" | "PATCH", body: unknown) {
  return new NextRequest("https://example.com/api/automations?id=automation_123", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function storedCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "automation_123",
    workspaceId: "workspace_123",
    instagramAccountId: "account_1",
    publicReplyEnabled: false,
    publicReplyMessages: [],
    publicReplyMessage: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.automation.findFirst.mockResolvedValue(storedCampaign());
  mockPrisma.automation.update.mockImplementation(async ({ data }) => ({
    id: "automation_123",
    ...data,
  }));
  mockPrisma.automation.create.mockImplementation(async ({ data }) => ({
    id: "automation_new",
    ...data,
  }));
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace_123" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "account_1" });
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
});

describe("public reply needs text", () => {
  it("POST rejects public reply on with only blank replies", async () => {
    const response = await POST(
      request("POST", {
        name: "ROADMAP",
        matchAnyPost: true,
        matchAnyWord: true,
        dmMessage: "Here you go {link}",
        publicReplyEnabled: true,
        publicReplyMessages: ["   ", ""],
      })
    );

    expect(response.status).toBe(400);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("PATCH rejects switching public reply on with an empty list", async () => {
    const response = await PATCH(
      request("PATCH", { publicReplyEnabled: true, publicReplyMessages: [""] })
    );

    expect(response.status).toBe(400);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("PATCH saves public reply on with one reply text", async () => {
    const response = await PATCH(
      request("PATCH", {
        publicReplyEnabled: true,
        publicReplyMessages: ["Sent you a DM! 📩"],
      })
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_123" },
      data: expect.objectContaining({ publicReplyMessages: ["Sent you a DM! 📩"] }),
    });
  });

  it("PATCH still pauses a stored campaign whose reply is on but empty", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(
      storedCampaign({ publicReplyEnabled: true })
    );

    const response = await PATCH(request("PATCH", { isActive: false }));

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalled();
  });
});
