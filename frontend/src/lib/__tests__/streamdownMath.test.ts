import { describe, expect, it } from "vitest";
import { repairJsonEscapedLatex, sanitizeStreamdownMath } from "@/lib/streamdownMath";
import { ensureDisplayMath } from "@/lib/text";

describe("repairJsonEscapedLatex", () => {
  it("repairs begin/text/frac/right stripped by JSON escapes", () => {
    const damaged =
      "egin{aligned} ext{Attention}(Q, K, V) &= oftmaxigg(rac{QK^T}{sqrt{d_k}})V ight. ight.";
    const fixed = repairJsonEscapedLatex(damaged);
    expect(fixed).toContain("\\begin{aligned}");
    expect(fixed).toContain("\\text{Attention}");
    expect(fixed).toContain("\\frac{QK^T}");
    expect(fixed).toContain("\\right.");
    expect(fixed).not.toMatch(/ight\. ight\./);
  });

  it("repairs control-character prefixes from invalid JSON", () => {
    const damaged = "\x08egin{aligned} \x09ext{Encoder}";
    const fixed = repairJsonEscapedLatex(damaged);
    expect(fixed).toContain("\\begin{aligned}");
    expect(fixed).toContain("\\text{Encoder}");
  });
});

describe("ensureDisplayMath", () => {
  it("wraps repaired transformer encoder equation", () => {
    const raw =
      "egin{aligned} ext{Encoder: } oldsymbol{z} &= ext{Encoder}(oldsymbol{x}_1) ight.";
    const out = ensureDisplayMath(raw);
    expect(out.startsWith("$$")).toBe(true);
    expect(out).toContain("\\begin{aligned}");
    expect(out).toContain("\\boldsymbol{z}");
  });
});

describe("sanitizeStreamdownMath", () => {
  it("applies json latex repair before delimiter fixes", () => {
    const out = sanitizeStreamdownMath("$$ egin{aligned} ext{a} = b ight. $$");
    expect(out).toContain("\\begin{aligned}");
    expect(out).toContain("\\text{a}");
  });
});
