from app.services.bibtex_export import (
    extract_bibtex_metadata,
    generate_bibtex_key,
    paper_to_bibtex,
)


def test_cite_key_format():
    used: set[str] = set()
    key = generate_bibtex_key(
        "Excited-State Forces within a First-Principles Green's Function Formalism",
        ["Sohrab Ismail-Beigi", "Steven G. Louie"],
        "2003",
        used_keys=used,
    )
    assert key == "excited2003ismail-beigi"


def test_cite_key_deduplicates():
    used: set[str] = set()
    k1 = generate_bibtex_key("Excited paper", ["A. Smith"], "2003", used_keys=used)
    k2 = generate_bibtex_key("Excited review", ["B. Smith"], "2003", used_keys=used)
    assert k1 == "excited2003smith"
    assert k2 == "excited2003smitha"


def test_extracts_doi_year_journal():
    raw = """
    Excited-State Forces within a First-Principles Green's Function Formalism
    Sohrab Ismail-Beigi and Steven G. Louie
    Phys. Rev. Lett. 91, 126401 (2003)
    DOI: 10.1103/PhysRevLett.91.126401
    """
    meta = extract_bibtex_metadata(
        title="Excited-State Forces",
        authors=["Sohrab Ismail-Beigi"],
        raw_text=raw,
    )
    assert meta.get("year") == "2003"
    assert meta.get("doi") == "10.1103/PhysRevLett.91.126401"
    assert "Phys" in (meta.get("journal") or "")


def test_paper_to_bibtex_rich_entry():
    raw = "Title block\nPhys. Rev. Lett. 91, 126401 (2003)\n10.1103/PhysRevLett.91.126401"
    bib = paper_to_bibtex(
        title="Excited-State Forces within a First-Principles Green's Function Formalism",
        authors=["Sohrab Ismail-Beigi", "Steven G. Louie"],
        raw_text=raw,
    )
    assert "@article{excited2003ismail-beigi," in bib
    assert "title = {Excited-State Forces" in bib
    assert "author = {Sohrab Ismail-Beigi and Steven G. Louie}" in bib
    assert "year = {2003}" in bib
    assert "doi = {10.1103/PhysRevLett.91.126401}" in bib
