import { describe, expect, it } from "vitest";
import { formatHighlightDisplay, isGarbledPdfHighlightText } from "../highlightDisplay";

describe("isGarbledPdfHighlightText", () => {
  it("flags PDF math token soup", () => {
    expect(isGarbledPdfHighlightText("X c0v0 HBSE cv;c0v0 AS c0v0 S AS cv")).toBe(true);
  });

  it("accepts normal prose", () => {
    expect(
      isGarbledPdfHighlightText(
        "We show that gradient descent converges under mild assumptions on the loss landscape.",
      ),
    ).toBe(false);
  });
});

describe("formatHighlightDisplay", () => {
  it("labels garbled math with page hint", () => {
    const out = formatHighlightDisplay("X c0v0 HBSE cv", [4]);
    expect(out.label).toBe("Mathematical expression");
    expect(out.detail).toBe("Page 4");
    expect(out.showRaw).toBe(true);
  });
});
