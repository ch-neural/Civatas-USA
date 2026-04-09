"""US-specific helpers for ap/services/evolution/app/predictor.py.

These mirror the small lookup helpers currently embedded in predictor.py
(``_get_leaning_for_candidate``, ``_calculate_heuristic_score``'s party-keyword
detection) but for US parties. They are imported by the country-aware shim
that gets added to predictor.py when this overlay is applied.

API:
  get_leaning_for_candidate(candidate_key) -> 5-tier label
  detect_party(text) -> "Democratic" | "Republican" | "Independent" | "Libertarian" | "Green" | None
  party_alignment_bonus(party, agent_leaning, base) -> float
  is_incumbent_keyword(desc) -> bool
  is_admin_keyword(desc) -> bool
"""
from __future__ import annotations

import re

# Lower-case keyword sets used to spot a US party label inside a free-form
# candidate description like "Democratic — Jane Doe (incumbent state senator)".
_DEM_KW = (
    "democratic", "democrat", "(d)", " d-", "dem ",
)
_REP_KW = (
    "republican", "(r)", " r-", "gop", "rep ",
)
_LIB_KW = ("libertarian", "(l)", " l-")
_GREEN_KW = ("green party", "(g)", " g-")
_IND_KW = ("independent", "(i)", "no party", "unaffiliated", "nonpartisan")


def _has_any(text: str, kws: tuple[str, ...]) -> bool:
    t = (text or "").lower()
    return any(k in t for k in kws)


def detect_party(text: str) -> str | None:
    if _has_any(text, _DEM_KW):
        return "Democratic"
    if _has_any(text, _REP_KW):
        return "Republican"
    if _has_any(text, _LIB_KW):
        return "Libertarian"
    if _has_any(text, _GREEN_KW):
        return "Green"
    if _has_any(text, _IND_KW):
        return "Independent"
    return None


def get_leaning_for_candidate(candidate_key: str) -> str:
    """Map a ground-truth candidate key to a 5-tier leaning label.

    Replaces predictor._get_leaning_for_candidate() for US workspaces.
    """
    party = detect_party(candidate_key)
    if party == "Democratic":
        return "Lean Dem"
    if party == "Republican":
        return "Lean Rep"
    if party == "Libertarian":
        return "Lean Rep"
    if party == "Green":
        return "Lean Dem"
    return "Tossup"


# Incumbency / executive role detection — replaces the regex on TW
# 市長/縣長/總統/院長 in predictor._calculate_heuristic_score.
_EXEC_RE = re.compile(
    r"\b(governor|mayor|president|county executive|attorney general|"
    r"lieutenant governor|secretary of state|state treasurer|comptroller)\b",
    re.IGNORECASE,
)
_ADMIN_RE = re.compile(
    r"\b(state senator|state representative|us senator|us representative|"
    r"congressman|congresswoman|assembly\w*|councilmember|"
    r"county commissioner|district attorney|city council|alderman|alderwoman|"
    r"school board|board of supervisors)\b",
    re.IGNORECASE,
)


def is_incumbent_keyword(desc: str) -> bool:
    return bool(_EXEC_RE.search(desc or ""))


def is_admin_keyword(desc: str) -> bool:
    return bool(_ADMIN_RE.search(desc or ""))


def party_alignment_bonus(party: str | None, agent_leaning_5tier: str, base: float) -> float:
    """Return the bonus to apply to a candidate's score given the agent's
    5-tier leaning. Mirrors the +/- structure used in predictor for KMT/DPP/TPP.
    """
    al = (agent_leaning_5tier or "").lower()
    if party == "Democratic":
        if "dem" in al:
            return base
        if "tossup" in al or al == "":
            return base * 0.3
        if "rep" in al:
            return -base * 0.5
    if party == "Republican":
        if "rep" in al:
            return base
        if "tossup" in al or al == "":
            return base * 0.3
        if "dem" in al:
            return -base * 0.5
    if party in ("Libertarian", "Green", "Independent"):
        if "tossup" in al:
            return base * 0.4
        return base * 0.1
    return 0.0
