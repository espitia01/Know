import { describe, expect, it } from "vitest";
import {
  dedupePriorWork,
  extractCitationShortLabel,
  formatReferenceEntry,
  isGarbledBibliographyLine,
  isUsableClusterTheme,
  sanitizeCitationForDisplay,
} from "../formatBibliography";

describe("formatBibliography", () => {
  it("flags table rows as garbled", () => {
    expect(isGarbledBibliographyLine("10.1 Excited state (~A1A00")).toBe(true);
    expect(isGarbledBibliographyLine("14.01 Excited state (A1) Re (Å ) !e (cm")).toBe(true);
    expect(isGarbledBibliographyLine("1.08 120")).toBe(true);
    expect(isGarbledBibliographyLine("105.0")).toBe(true);
    expect(isGarbledBibliographyLine("5.7 P H Y S I C A L R E V I E W L E T T E R S")).toBe(true);
  });

  it("keeps normal bibliography lines", () => {
    const line = "[3] F. Mauri and R. Car, Phys. Rev. Lett. 75, 3166 (1995).";
    expect(isGarbledBibliographyLine(line)).toBe(false);
    expect(sanitizeCitationForDisplay(line)).toContain("Mauri");
  });

  it("formats references like cited-by rows", () => {
    const label = formatReferenceEntry({
      citation_display: "[3] F. Mauri and R. Car, Phys. Rev. Lett. 75, 3166 (1995).",
    });
    expect(label).toContain("Mauri");
    expect(label).toContain("(1995)");
    expect(label).toContain("Phys. Rev. Lett.");
  });

  it("dedupes prior work entries", () => {
    const items = dedupePriorWork([
      { citation_display: "[3] F. Mauri and R. Car, Phys. Rev. Lett. 75, 3166 (1995)." },
      { citation_display: "[3] F. Mauri and R. Car, Phys. Rev. Lett. 75, 3166 (1995)." },
    ]);
    expect(items).toHaveLength(1);
  });

  it("extracts short author-year labels", () => {
    const label = extractCitationShortLabel(
      "[3] F. Mauri and R. Car, Phys. Rev. Lett. 75, 3166 (1995).",
    );
    expect(label).toContain("Mauri");
    expect(label).toContain("1995");
  });

  it("rejects garbled cluster themes", () => {
    expect(isUsableClusterTheme("Prior excited-state force work and BSE corrections")).toBe(true);
    expect(isUsableClusterTheme("10.1 Excited state (~A1")).toBe(false);
  });
});
