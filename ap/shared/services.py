"""Service registry — centralized service URLs and timeout configuration."""

from dataclasses import dataclass
import os


@dataclass
class ServiceConfig:
    url: str
    timeout: float = 300.0
    max_retries: int = 3
    circuit_breaker_threshold: int = 5
    circuit_breaker_cooldown: float = 60.0


def _env_url(name: str, default: str) -> str:
    """Allow service URLs to be overridden via environment variables."""
    return os.getenv(f"{name.upper()}_URL", default)


SERVICES: dict[str, ServiceConfig] = {
    "ingestion": ServiceConfig(
        url=_env_url("ingestion", "http://ingestion:8000"),
        timeout=120.0,
    ),
    "synthesis": ServiceConfig(
        url=_env_url("synthesis", "http://synthesis:8000"),
        timeout=300.0,
    ),
    "persona": ServiceConfig(
        url=_env_url("persona", "http://persona:8000"),
        timeout=600.0,
    ),
    "evolution": ServiceConfig(
        url=_env_url("evolution", "http://evolution:8000"),
        timeout=600.0,
    ),
    "social": ServiceConfig(
        url=_env_url("social", "http://social:8000"),
        timeout=300.0,
    ),
    "adapter": ServiceConfig(
        url=_env_url("adapter", "http://adapter:8000"),
        timeout=300.0,
    ),
    "simulation": ServiceConfig(
        url=_env_url("simulation", "http://simulation:8000"),
        timeout=600.0,
    ),
    "analytics": ServiceConfig(
        url=_env_url("analytics", "http://analytics:8000"),
        timeout=300.0,
    ),
}


def get_service(name: str) -> ServiceConfig:
    """Get service configuration by name."""
    if name not in SERVICES:
        raise ValueError(f"Unknown service: {name}")
    return SERVICES[name]
