"""Resilient HTTP client with retry, circuit breaker, and structured errors."""

import asyncio
import logging
import random
import time
from typing import Any, Optional

import httpx

from .services import ServiceConfig, get_service

logger = logging.getLogger(__name__)


class CircuitBreakerOpen(Exception):
    """Raised when circuit breaker is open and requests are blocked."""
    pass


class ServiceError(Exception):
    """Structured error from a downstream service call."""
    def __init__(self, service: str, endpoint: str, status: int, detail: str):
        self.service = service
        self.endpoint = endpoint
        self.status = status
        self.detail = detail
        super().__init__(f"[{service}] {endpoint} → {status}: {detail}")


class _CircuitBreaker:
    """Per-service circuit breaker."""

    def __init__(self, threshold: int = 5, cooldown: float = 60.0):
        self.threshold = threshold
        self.cooldown = cooldown
        self.failures = 0
        self.tripped_at: Optional[float] = None

    @property
    def is_open(self) -> bool:
        if self.tripped_at is None:
            return False
        if time.time() - self.tripped_at > self.cooldown:
            # Half-open: allow one attempt
            self.tripped_at = None
            self.failures = 0
            return False
        return True

    def record_failure(self):
        self.failures += 1
        if self.failures >= self.threshold:
            self.tripped_at = time.time()
            logger.warning(
                f"Circuit breaker tripped after {self.failures} failures, "
                f"cooldown {self.cooldown}s"
            )

    def record_success(self):
        self.failures = 0
        self.tripped_at = None


class ResilientClient:
    """HTTP client with retry + circuit breaker for one downstream service."""

    def __init__(self, service_name: str, config: Optional[ServiceConfig] = None):
        self.service_name = service_name
        self.config = config or get_service(service_name)
        self._breaker = _CircuitBreaker(
            threshold=self.config.circuit_breaker_threshold,
            cooldown=self.config.circuit_breaker_cooldown,
        )

    async def post(
        self,
        endpoint: str,
        json: Optional[dict] = None,
        data: Any = None,
        files: Any = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
    ) -> dict:
        return await self._request("POST", endpoint, json=json, data=data, files=files,
                                   timeout=timeout, retries=retries)

    async def get(
        self,
        endpoint: str,
        params: Optional[dict] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
    ) -> dict:
        return await self._request("GET", endpoint, params=params,
                                   timeout=timeout, retries=retries)

    async def put(
        self,
        endpoint: str,
        json: Optional[dict] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        return await self._request("PUT", endpoint, json=json, timeout=timeout)

    async def delete(
        self,
        endpoint: str,
        timeout: Optional[float] = None,
    ) -> dict:
        return await self._request("DELETE", endpoint, timeout=timeout)

    async def _request(
        self,
        method: str,
        endpoint: str,
        json: Optional[dict] = None,
        data: Any = None,
        files: Any = None,
        params: Optional[dict] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
    ) -> dict:
        if self._breaker.is_open:
            raise CircuitBreakerOpen(
                f"Circuit breaker open for {self.service_name}, "
                f"retry after {self.config.circuit_breaker_cooldown}s"
            )

        url = f"{self.config.url}{endpoint}"
        effective_timeout = timeout or self.config.timeout
        max_retries = retries if retries is not None else self.config.max_retries

        last_error: Optional[Exception] = None

        for attempt in range(max_retries):
            try:
                async with httpx.AsyncClient(timeout=effective_timeout) as client:
                    resp = await client.request(
                        method,
                        url,
                        json=json,
                        data=data,
                        files=files,
                        params=params,
                    )

                if resp.status_code >= 500:
                    # Server error → retry
                    error_text = resp.text[:500]
                    last_error = ServiceError(
                        self.service_name, endpoint, resp.status_code, error_text
                    )
                    self._breaker.record_failure()
                    if attempt < max_retries - 1:
                        wait = (2 ** attempt) + random.uniform(0, 1)
                        logger.warning(
                            f"[{self.service_name}] {method} {endpoint} → {resp.status_code}, "
                            f"retrying in {wait:.1f}s (attempt {attempt + 1}/{max_retries})"
                        )
                        await asyncio.sleep(wait)
                        continue
                    raise last_error

                if resp.status_code >= 400:
                    # Client error → don't retry
                    error_text = resp.text[:500]
                    raise ServiceError(
                        self.service_name, endpoint, resp.status_code, error_text
                    )

                # Success
                self._breaker.record_success()
                try:
                    return resp.json()
                except Exception:
                    return {"raw": resp.text}

            except (httpx.ConnectError, httpx.TimeoutException, httpx.ReadTimeout) as e:
                self._breaker.record_failure()
                last_error = e
                if attempt < max_retries - 1:
                    wait = (2 ** attempt) + random.uniform(0, 1)
                    logger.warning(
                        f"[{self.service_name}] {method} {endpoint} → {type(e).__name__}, "
                        f"retrying in {wait:.1f}s (attempt {attempt + 1}/{max_retries})"
                    )
                    await asyncio.sleep(wait)
                    continue
                raise ServiceError(
                    self.service_name,
                    endpoint,
                    503,
                    f"Service unavailable after {max_retries} attempts: {e}",
                )

        raise last_error or ServiceError(
            self.service_name, endpoint, 503, "Max retries exceeded"
        )

    async def health_check(self) -> bool:
        """Quick health check (2s timeout, no retry)."""
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"{self.config.url}/health")
                return resp.status_code == 200
        except Exception:
            return False


# Pre-built clients (lazy singleton pattern)
_clients: dict[str, ResilientClient] = {}


def get_client(service_name: str) -> ResilientClient:
    """Get or create a ResilientClient for the named service."""
    if service_name not in _clients:
        _clients[service_name] = ResilientClient(service_name)
    return _clients[service_name]
