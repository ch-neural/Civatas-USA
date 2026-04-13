"""
US Life Events — Random life event module for American agents.

Each day, ~8% of agents may experience a life event based on their
demographics. Events affect satisfaction and anxiety, and inject
a prompt_hint into the LLM diary generation.
"""
from __future__ import annotations

from typing import Any

# ── Occupation groups ─────────────────────────────────────────────
_WHITE_COLLAR = {
    "Employed",  # catch-all for ACS employed
    "Engineer", "Software Engineer", "Teacher", "Professor", "Doctor",
    "Nurse", "Lawyer", "Accountant", "Banker", "Analyst", "Consultant",
    "Manager", "Director", "Designer", "Marketing", "Sales",
}
_BLUE_COLLAR = {
    "Worker", "Technician", "Driver", "Delivery", "Retail",
    "Service", "Restaurant", "Security", "Janitor", "Construction",
    "Plumber", "Electrician", "Farmer", "Factory",
}
_STUDENT = {"Student"}
_RETIRED = {"Retired", "Not in Labor Force"}
_MILITARY = {"Armed Forces"}

# ── US Event Catalog ──────────────────────────────────────────────

US_EVENT_CATALOG: list[dict[str, Any]] = [
    # ════════════ ECONOMIC ════════════
    {
        "id": "eco_layoff",
        "name": "Laid off",
        "category": "economic",
        "description": "Company downsizing — got the pink slip today",
        "probability": 0.12,
        "eligibility": {"age_min": 22, "age_max": 62, "occupation_exclude": _STUDENT | _RETIRED | _MILITARY},
        "effects": {"satisfaction_delta": -12, "anxiety_delta": 18},
        "cooldown_days": 90,
        "prompt_hint": "You were just laid off from your job. You're anxious about bills and job hunting.",
    },
    {
        "id": "eco_raise",
        "name": "Got a raise",
        "category": "economic",
        "description": "Boss announced a raise effective next month",
        "probability": 0.08,
        "eligibility": {"age_min": 23, "age_max": 62, "occupation_exclude": _STUDENT | _RETIRED},
        "effects": {"satisfaction_delta": 8, "anxiety_delta": -6},
        "cooldown_days": 180,
        "prompt_hint": "You just got a raise at work. Feeling optimistic about finances.",
    },
    {
        "id": "eco_promotion",
        "name": "Promoted",
        "category": "economic",
        "description": "Got promoted to a senior role with more responsibility",
        "probability": 0.05,
        "eligibility": {"age_min": 28, "age_max": 55, "occupation_exclude": _STUDENT | _RETIRED},
        "effects": {"satisfaction_delta": 10, "anxiety_delta": -4},
        "cooldown_days": 365,
        "prompt_hint": "You were just promoted at work. Excited but also feeling the pressure of new responsibilities.",
    },
    {
        "id": "eco_medical_bill",
        "name": "Unexpected medical bill",
        "category": "economic",
        "description": "Got a surprise $3,000 medical bill from an ER visit",
        "probability": 0.10,
        "eligibility": {"age_min": 18, "age_max": 90},
        "effects": {"satisfaction_delta": -8, "anxiety_delta": 12},
        "cooldown_days": 120,
        "prompt_hint": "You received an unexpected medical bill for thousands of dollars. Healthcare costs are on your mind.",
    },
    {
        "id": "eco_rent_increase",
        "name": "Rent went up",
        "category": "economic",
        "description": "Landlord raised rent by 15% — nowhere affordable to move",
        "probability": 0.10,
        "eligibility": {"age_min": 18, "age_max": 70, "tenure": "Renter"},
        "effects": {"satisfaction_delta": -7, "anxiety_delta": 10},
        "cooldown_days": 180,
        "prompt_hint": "Your landlord just raised the rent significantly. You're stressed about housing costs.",
    },
    {
        "id": "eco_side_gig",
        "name": "Started a side gig",
        "category": "economic",
        "description": "Picked up freelance work or started driving for a rideshare app",
        "probability": 0.06,
        "eligibility": {"age_min": 20, "age_max": 55},
        "effects": {"satisfaction_delta": 3, "anxiety_delta": -2},
        "cooldown_days": 120,
        "prompt_hint": "You started a side gig to earn extra money. Feeling resourceful but tired.",
    },
    {
        "id": "eco_gas_prices",
        "name": "Gas prices spiked",
        "category": "economic",
        "description": "Gas hit $5/gallon again — commute costs doubled",
        "probability": 0.08,
        "eligibility": {"age_min": 18, "age_max": 75},
        "effects": {"satisfaction_delta": -4, "anxiety_delta": 6},
        "cooldown_days": 60,
        "prompt_hint": "Gas prices spiked this week. Your commute and grocery bills are eating into savings.",
    },

    # ════════════ FAMILY / SOCIAL ════════════
    {
        "id": "fam_baby",
        "name": "Had a baby",
        "category": "family",
        "description": "Welcome to parenthood — exhausted but overjoyed",
        "probability": 0.03,
        "eligibility": {"age_min": 22, "age_max": 42},
        "effects": {"satisfaction_delta": 12, "anxiety_delta": 8},
        "cooldown_days": 365,
        "prompt_hint": "You just had a baby. Overwhelmed with joy but worried about childcare costs and work-life balance.",
    },
    {
        "id": "fam_divorce",
        "name": "Going through a divorce",
        "category": "family",
        "description": "Marriage falling apart — lawyer fees, custody stress",
        "probability": 0.04,
        "eligibility": {"age_min": 25, "age_max": 65, "married": True},
        "effects": {"satisfaction_delta": -15, "anxiety_delta": 20},
        "cooldown_days": 365,
        "prompt_hint": "You're going through a painful divorce. Legal fees, custody worries, and emotional exhaustion.",
    },
    {
        "id": "fam_kid_college",
        "name": "Kid got into college",
        "category": "family",
        "description": "Proud moment — but tuition costs are terrifying",
        "probability": 0.05,
        "eligibility": {"age_min": 40, "age_max": 60, "has_children": True},
        "effects": {"satisfaction_delta": 6, "anxiety_delta": 8},
        "cooldown_days": 365,
        "prompt_hint": "Your kid got accepted to college. You're proud but anxious about student loans and tuition.",
    },
    {
        "id": "fam_parent_sick",
        "name": "Parent fell ill",
        "category": "family",
        "description": "Mom or Dad was hospitalized — juggling caregiving and work",
        "probability": 0.06,
        "eligibility": {"age_min": 35, "age_max": 65},
        "effects": {"satisfaction_delta": -8, "anxiety_delta": 12},
        "cooldown_days": 90,
        "prompt_hint": "Your parent was hospitalized. You're worried about their health, Medicare coverage, and caregiving.",
    },
    {
        "id": "fam_engagement",
        "name": "Got engaged",
        "category": "family",
        "description": "Popped the question — said yes!",
        "probability": 0.03,
        "eligibility": {"age_min": 22, "age_max": 45, "married": False},
        "effects": {"satisfaction_delta": 10, "anxiety_delta": -5},
        "cooldown_days": 365,
        "prompt_hint": "You just got engaged! Planning a wedding, thinking about the future together.",
    },

    # ════════════ HEALTH ════════════
    {
        "id": "health_injury",
        "name": "Got injured",
        "category": "health",
        "description": "Twisted ankle / car accident / minor surgery",
        "probability": 0.06,
        "eligibility": {"age_min": 18, "age_max": 85},
        "effects": {"satisfaction_delta": -6, "anxiety_delta": 8},
        "cooldown_days": 60,
        "prompt_hint": "You got injured and had to visit the ER. Dealing with pain, missed work, and insurance paperwork.",
    },
    {
        "id": "health_diagnosis",
        "name": "Received a diagnosis",
        "category": "health",
        "description": "Doctor found something concerning — need follow-up tests",
        "probability": 0.04,
        "eligibility": {"age_min": 40, "age_max": 90},
        "effects": {"satisfaction_delta": -10, "anxiety_delta": 15},
        "cooldown_days": 180,
        "prompt_hint": "You received a worrying medical diagnosis. Scared about treatment costs and your future health.",
    },
    {
        "id": "health_recovery",
        "name": "Recovered from illness",
        "category": "health",
        "description": "Finally feeling better after weeks of being sick",
        "probability": 0.06,
        "eligibility": {"age_min": 18, "age_max": 90},
        "effects": {"satisfaction_delta": 6, "anxiety_delta": -4},
        "cooldown_days": 90,
        "prompt_hint": "You finally recovered from a long illness. Grateful for your health and the people who helped.",
    },

    # ════════════ COMMUNITY / CRIME ════════════
    {
        "id": "com_car_break_in",
        "name": "Car was broken into",
        "category": "community",
        "description": "Came back to smashed window and stolen stuff",
        "probability": 0.06,
        "eligibility": {"age_min": 18, "age_max": 80},
        "effects": {"satisfaction_delta": -8, "anxiety_delta": 10},
        "cooldown_days": 90,
        "prompt_hint": "Someone broke into your car. You feel unsafe and angry about crime in your neighborhood.",
    },
    {
        "id": "com_neighbor_help",
        "name": "Neighbor helped you out",
        "category": "community",
        "description": "Neighbor lent a hand when you needed it most",
        "probability": 0.08,
        "eligibility": {"age_min": 18, "age_max": 90},
        "effects": {"satisfaction_delta": 5, "anxiety_delta": -3},
        "cooldown_days": 30,
        "prompt_hint": "A neighbor helped you out today — restored your faith in community.",
    },
    {
        "id": "com_gun_incident",
        "name": "Heard gunshots nearby",
        "category": "community",
        "description": "Shots fired in the neighborhood — police everywhere",
        "probability": 0.04,
        "eligibility": {"age_min": 18, "age_max": 90},
        "effects": {"satisfaction_delta": -10, "anxiety_delta": 15},
        "cooldown_days": 60,
        "prompt_hint": "There was a shooting incident near your neighborhood. You're shaken and thinking about gun policy.",
    },
    {
        "id": "com_volunteer",
        "name": "Volunteered at local event",
        "category": "community",
        "description": "Spent the day helping at a food bank or church event",
        "probability": 0.06,
        "eligibility": {"age_min": 18, "age_max": 80},
        "effects": {"satisfaction_delta": 5, "anxiety_delta": -3},
        "cooldown_days": 30,
        "prompt_hint": "You volunteered at a local community event. Felt good to give back.",
    },

    # ════════════ EDUCATION / CAREER ════════════
    {
        "id": "edu_student_loan",
        "name": "Student loan payment due",
        "category": "education",
        "description": "Monthly student loan payment reminder — that balance never shrinks",
        "probability": 0.08,
        "eligibility": {"age_min": 22, "age_max": 45},
        "effects": {"satisfaction_delta": -3, "anxiety_delta": 5},
        "cooldown_days": 30,
        "prompt_hint": "Your student loan payment hit today. Frustrated with how long it takes to pay off.",
    },
    {
        "id": "edu_graduation",
        "name": "Graduated / Got a certification",
        "category": "education",
        "description": "Finally finished that degree or professional certification",
        "probability": 0.03,
        "eligibility": {"age_min": 20, "age_max": 50},
        "effects": {"satisfaction_delta": 10, "anxiety_delta": -5},
        "cooldown_days": 365,
        "prompt_hint": "You just graduated or earned a professional certification. Feeling accomplished and hopeful.",
    },

    # ════════════ POLITICAL / CIVIC ════════════
    {
        "id": "pol_jury_duty",
        "name": "Called for jury duty",
        "category": "political",
        "description": "Got a jury duty summons — have to take time off work",
        "probability": 0.04,
        "eligibility": {"age_min": 18, "age_max": 75},
        "effects": {"satisfaction_delta": -2, "anxiety_delta": 3},
        "cooldown_days": 365,
        "prompt_hint": "You got called for jury duty. Thinking about the justice system and civic responsibility.",
    },
    {
        "id": "pol_town_hall",
        "name": "Attended a town hall",
        "category": "political",
        "description": "Went to a local town hall meeting about zoning or school funding",
        "probability": 0.05,
        "eligibility": {"age_min": 25, "age_max": 75},
        "effects": {"satisfaction_delta": 3, "anxiety_delta": -1},
        "cooldown_days": 60,
        "prompt_hint": "You attended a local town hall. Heard what your neighbors think about local issues.",
    },

    # ════════════ IMMIGRATION-SPECIFIC ════════════
    {
        "id": "imm_family_status",
        "name": "Immigration status worry",
        "category": "immigration",
        "description": "Family member's visa or green card renewal is uncertain",
        "probability": 0.06,
        "eligibility": {"age_min": 18, "age_max": 70, "hispanic_or_latino": "Hispanic or Latino"},
        "effects": {"satisfaction_delta": -8, "anxiety_delta": 14},
        "cooldown_days": 90,
        "prompt_hint": "A family member's immigration status is uncertain. You're deeply worried about deportation policies.",
    },

    # ════════════ RACE-SPECIFIC ════════════
    {
        "id": "race_discrimination",
        "name": "Experienced discrimination",
        "category": "race",
        "description": "Faced racial profiling or a microaggression at work/store",
        "probability": 0.05,
        "eligibility": {"age_min": 18, "age_max": 80, "race_not": "White"},
        "effects": {"satisfaction_delta": -8, "anxiety_delta": 10},
        "cooldown_days": 60,
        "prompt_hint": "You experienced racial discrimination today. It reminded you how much further the country has to go on civil rights.",
    },

    # ════════════ WEATHER / NATURAL ════════════
    {
        "id": "nat_extreme_weather",
        "name": "Extreme weather event",
        "category": "natural",
        "description": "Hurricane warning / wildfire smoke / flooding in your area",
        "probability": 0.04,
        "eligibility": {"age_min": 18, "age_max": 90},
        "effects": {"satisfaction_delta": -6, "anxiety_delta": 10},
        "cooldown_days": 30,
        "prompt_hint": "Extreme weather hit your area. You're thinking about climate change, disaster preparedness, and government response.",
    },
]
