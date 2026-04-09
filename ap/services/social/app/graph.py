"""Social graph construction with homophily bias."""
from __future__ import annotations

import random


def build_follow_graph(
    agents: list[dict],
    density: float = 0.02,
    homophily_fields: list[str] | None = None,
) -> list[dict]:
    """Build follow edges with homophily-weighted probability.

    Agents sharing values in homophily_fields are more likely to follow
    each other.
    """
    homophily_fields = homophily_fields or []
    n = len(agents)
    edges: list[dict] = []

    for i in range(n):
        target_follows = max(1, int(n * density))
        candidates = list(range(n))
        candidates.remove(i)

        weights = []
        for j in candidates:
            w = 1.0
            for field in homophily_fields:
                if agents[i].get(field) and agents[i][field] == agents[j].get(field):
                    w *= 2.0
            weights.append(w)

        total_w = sum(weights)
        if total_w == 0:
            continue
        probs = [w / total_w for w in weights]

        k = min(target_follows, len(candidates))
        chosen = _weighted_sample(candidates, probs, k)
        for j in chosen:
            edges.append({"follower": i, "followee": j})

    return edges


def _weighted_sample(
    population: list[int], weights: list[float], k: int
) -> list[int]:
    """Sample k items without replacement, weighted."""
    selected: list[int] = []
    pop = list(population)
    w = list(weights)
    for _ in range(k):
        if not pop:
            break
        total = sum(w)
        if total == 0:
            break
        r = random.uniform(0, total)
        cumulative = 0.0
        for idx, weight in enumerate(w):
            cumulative += weight
            if r <= cumulative:
                selected.append(pop[idx])
                pop.pop(idx)
                w.pop(idx)
                break
    return selected
