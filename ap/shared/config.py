"""Centralized configuration constants — replaces hardcoded values across services."""

import os

# Circuit breaker
CIRCUIT_BREAKER_THRESHOLD = int(os.getenv("CIRCUIT_BREAKER_THRESHOLD", "5"))
CIRCUIT_BREAKER_COOLDOWN_SEC = float(os.getenv("CIRCUIT_BREAKER_COOLDOWN", "60"))

# Feed engine
SERENDIPITY_RATE = float(os.getenv("SERENDIPITY_RATE", "0.05"))
DEFAULT_ARTICLES_PER_AGENT = int(os.getenv("DEFAULT_ARTICLES_PER_AGENT", "3"))

# Feed scoring weights (must sum to 1.0)
FEED_WEIGHT_CHANNEL = float(os.getenv("FEED_WEIGHT_CHANNEL", "0.5"))
FEED_WEIGHT_LEANING = float(os.getenv("FEED_WEIGHT_LEANING", "0.3"))
FEED_WEIGHT_RECENCY = float(os.getenv("FEED_WEIGHT_RECENCY", "0.2"))

# LLM defaults
DEFAULT_LLM_TEMPERATURE = float(os.getenv("DEFAULT_LLM_TEMPERATURE", "0.8"))
REASONING_MODEL_TEMPERATURE = float(os.getenv("REASONING_MODEL_TEMPERATURE", "1.0"))

# Persona generation
DEFAULT_PERSONA_CONCURRENCY = int(os.getenv("DEFAULT_PERSONA_CONCURRENCY", "5"))
DEFAULT_PERSONA_STRATEGY = os.getenv("DEFAULT_PERSONA_STRATEGY", "template")

# Evolution
DEFAULT_EVOLUTION_DAYS = int(os.getenv("DEFAULT_EVOLUTION_DAYS", "7"))
DEFAULT_EVOLUTION_CONCURRENCY = int(os.getenv("DEFAULT_EVOLUTION_CONCURRENCY", "5"))

# Recency decay thresholds (days → score)
RECENCY_DECAY = {
    1: 1.0,
    3: 0.7,
    7: 0.4,
    float("inf"): 0.1,
}
