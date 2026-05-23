import { describe, expect, it } from "vitest";
import {
  dedupePriorWork,
  filterUsablePriorWork,
  formatReferenceEntry,
  isGarbledBibliographyLine,
  looksLikeBibliographyLine,
  sanitizeCitationFullText,
} from "../formatBibliography";

const GW_BSE_ENTRIES = [
  {
    bib_label: "1",
    citation_display:
      "[1] M. Rohlfing and S. G. Louie, Phys. Rev. Lett. 81, 2312 (1998); S. Albrecht, L. Reining, R. Del Sole, and G. Onida, Phys. Rev. Lett. 80, 4510 (1998); L. X. Benedict, E. L. Shirley, and R. B. Bohn, Phys. Rev. Lett. 80, 4514 (1998).",
  },
  {
    bib_label: "2",
    citation_display:
      "[2] M. Rohlfing and S. G. Louie, Phys. Rev. B 62, 4927 (2000); G. Onida, L. Reining, and A. Rubio, Rev. Mod. Phys. 74, 601 (2002).",
  },
  { bib_label: "3", citation_display: "[3] F. Mauri and R. Car, Phys. Rev. Lett. 75, 3166 (1995)." },
  {
    bib_label: "4",
    citation_display:
      "[4] J. F. Stanton, J. Gauss, N. Ishikawa, and M. Head- Gordon, J. Phys. Chem. 103, 4160 (1995).",
  },
  {
    bib_label: "5",
    citation_display:
      "[5] K.W. Sattelmeyer, J. F. Stanton, J. Olsen, and J. Gauss, Chem. Phys. Lett. 347, 499 (2001).",
  },
  {
    bib_label: "6",
    citation_display:
      "[6] M. C. Payne, M. P. Teter, D. C. Allan, T. A. Arias, and J. D. Joannopoulos, Rev. Mod. Phys. 64, 1045 (1992), and references therein.",
  },
  {
    bib_label: "7",
    citation_display: "[7] M. S. Hybertsen and S. G. Louie, Phys. Rev. B 34, 5390 (1986).",
  },
  {
    bib_label: "8",
    citation_display: "[8] X. Gonze, D. C. Allan, and M. P. Teter, Phys. Rev. Lett. 68, 3603 (1992).",
  },
  {
    bib_label: "9",
    citation_display: "[9] L. Kleinman and D. M. Bylander, Phys. Rev. Lett. 48, 1425 (1982).",
  },
  {
    bib_label: "10",
    citation_display:
      "[10] J. C. Grossman, M. Rohlfing, L. Mitas, S. G. Louie, and M. L. Cohen, Phys. Rev. Lett. 86, 472 (2001).",
  },
  {
    bib_label: "11",
    citation_display:
      "[11] NIST Chemistry WebBook, NIST Standard Reference Database #69, edited by P. J. Linstrom and W. G. Mallard, 2001 (http://webbook.nist.gov).",
  },
  {
    bib_label: "12",
    citation_display:
      "[12] G. Herzberg, Electronic Spectra and Electronic Struc- ture of Polyatomic Molecules (Krieger, New York, 1991).",
  },
  {
    bib_label: "13",
    citation_display:
      "[13] M. I. McCarthy, P. Rosums, H.-J. Werner, P. Botschwina, and V. Vaida, J. Chem. Phys. 86, 6693 (1987).",
  },
];

describe("GW-BSE reference list", () => {
  it("keeps all 13 bibliography rows", () => {
    const usable = dedupePriorWork(filterUsablePriorWork(GW_BSE_ENTRIES));
    expect(usable.map((e) => e.bib_label)).toEqual(
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"],
    );
  });

  it("keeps rows when TABLE II bleeds into the last chunk", () => {
    const entries = GW_BSE_ENTRIES.map((e) =>
      e.bib_label === "13"
        ? {
            ...e,
            citation_display:
              "[13] M. I. McCarthy, P. Rosums, H.-J. Werner, P. Botschwina, and V. Vaida, J. Chem. Phys. 86, 6693 (1987).\nTABLE II. Ground-state",
          }
        : e,
    );
    const usable = dedupePriorWork(filterUsablePriorWork(entries));
    expect(usable.some((e) => e.bib_label === "13")).toBe(true);
  });

  it("does not flag real citations as garbled", () => {
    for (const e of GW_BSE_ENTRIES) {
      expect(isGarbledBibliographyLine(e.citation_display)).toBe(false);
    }
  });

  it("formats Stanton with full author list", () => {
    const label = formatReferenceEntry(GW_BSE_ENTRIES[3]);
    expect(label).toContain("Stanton");
    expect(label).toContain("Gauss");
    expect(label).toContain("J. Phys. Chem.");
  });

  it("formats Herzberg book without duplication", () => {
    const entry = GW_BSE_ENTRIES[11];
    const full = sanitizeCitationFullText(entry.citation_display);
    expect(isGarbledBibliographyLine(full)).toBe(false);
    expect(looksLikeBibliographyLine(entry.citation_display)).toBe(true);
    const label = formatReferenceEntry(entry);
    expect(label).toContain("Herzberg");
    expect(label).toContain("(1991)");
    expect(label).toContain("Polyatomic Molecules");
    expect(label?.includes("Herzberg, Electronic")).toBe(false);
  });
});
