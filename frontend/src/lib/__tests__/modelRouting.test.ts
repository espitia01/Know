import { describe, expect, it } from "vitest";
import { normalizeModelSlug } from "@/lib/modelLabels";
import { providerForSlug, toGatewayModelId } from "@/lib/modelGateway";

describe("model routing", () => {
  it("canonicalizes retired Anthropic 4.x ids", () => {
    expect(normalizeModelSlug("claude-sonnet-4-6")).toBe("claude-sonnet-5");
    expect(normalizeModelSlug("claude-opus-4-7")).toBe("claude-opus-5");
  });

  it("maps first-party slugs to AI Gateway catalog ids", () => {
    expect(toGatewayModelId("claude-haiku-4-5")).toBe("anthropic/claude-haiku-4.5");
    expect(toGatewayModelId("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(toGatewayModelId("mistral-small-latest")).toBe("mistral/mistral-small");
    expect(toGatewayModelId("gpt-5-mini")).toBe("openai/gpt-5-mini");
  });

  it("rejects unknown slugs", () => {
    expect(() => providerForSlug("unknown-model")).toThrow(/Unknown model slug/);
  });
});
