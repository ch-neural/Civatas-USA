"""Default persona templates per locale.

Templates use a segment-based approach: each segment is conditionally
included only when the corresponding field has a value.
"""

# Each segment is a (format_string, required_fields) tuple.
# A segment is only included if ALL required_fields have non-empty values.

SEGMENTS_ZH_TW = [
    ("{age}歲{gender}", ["age", "gender"]),
    ("住在{district}", ["district"]),
    ("職業為{occupation}", ["occupation"]),
    ("{education}", ["education"]),
    ("{marital_status}", ["marital_status"]),
    ("關心{issue_1}", ["issue_1"]),
    ("也關注{issue_2}", ["issue_2"]),
    ("政治傾向{party_lean}", ["party_lean"]),
    ("常使用{media_habit}", ["media_habit"]),
    ("MBTI為{mbti}", ["mbti"]),
]

SEGMENTS_EN = [
    ("{age}-year-old {gender}", ["age", "gender"]),
    ("living in {district}", ["district"]),
    ("working as {occupation}", ["occupation"]),
    ("{education}", ["education"]),
    ("{marital_status}", ["marital_status"]),
    ("cares about {issue_1}", ["issue_1"]),
    ("also interested in {issue_2}", ["issue_2"]),
    ("politically {party_lean}", ["party_lean"]),
    ("regularly uses {media_habit}", ["media_habit"]),
    ("MBTI: {mbti}", ["mbti"]),
]

LOCALE_SEGMENTS: dict[str, list[tuple[str, list[str]]]] = {
    "zh-TW": SEGMENTS_ZH_TW,
    "en": SEGMENTS_EN,
    # Civatas-USA Stage 1.5+: aliases so en-US / en-GB don't fall back to zh-TW.
    "en-US": SEGMENTS_EN,
    "en-GB": SEGMENTS_EN,
}

# Separator used between segments
LOCALE_SEPARATOR: dict[str, str] = {
    "zh-TW": "，",
    "en": ", ",
    "en-US": ", ",
    "en-GB": ", ",
}
