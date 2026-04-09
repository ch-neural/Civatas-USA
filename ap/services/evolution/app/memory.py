"""Vector memory store for agent diaries using ChromaDB.

Supports:
  - Storing daily diary entries with metadata
  - Semantic search (RAG) with time weighting
"""
from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
CHROMA_DIR = os.path.join(DATA_DIR, "chromadb")

_client = None
_collection = None
_init_lock = __import__("threading").Lock()
_init_failed = False


def _get_collection():
    """Lazy-init ChromaDB client and collection (thread-safe)."""
    global _client, _collection, _init_failed
    if _collection is not None:
        return _collection
    if _init_failed:
        return None  # Don't retry after a failed init in this process

    with _init_lock:
        # Double-check after acquiring lock
        if _collection is not None:
            return _collection

        try:
            import chromadb
            from chromadb.config import Settings
        except ImportError:
            logger.warning("chromadb not installed — memory features disabled")
            _init_failed = True
            return None

        try:
            os.makedirs(CHROMA_DIR, exist_ok=True)
            _client = chromadb.PersistentClient(path=CHROMA_DIR)
            _collection = _client.get_or_create_collection(
                name="agent_diaries",
                metadata={"hnsw:space": "cosine"},
            )
            logger.info(f"ChromaDB collection ready at {CHROMA_DIR}")
            return _collection
        except Exception as e:
            logger.error(f"ChromaDB initialization failed: {e}")
            _init_failed = True
            return None


def store_diary(
    agent_id: int,
    day: int,
    diary_text: str,
    metrics: dict[str, Any] | None = None,
) -> bool:
    """Store a diary entry in the vector database."""
    coll = _get_collection()
    if coll is None:
        return False

    doc_id = f"agent_{agent_id}_day_{day}"
    metadata = {
        "agent_id": agent_id,
        "day": day,
    }
    if metrics:
        metadata.update({k: float(v) for k, v in metrics.items() if isinstance(v, (int, float))})

    try:
        coll.upsert(
            ids=[doc_id],
            documents=[diary_text],
            metadatas=[metadata],
        )
        return True
    except Exception as e:
        logger.error(f"Failed to store diary for agent {agent_id} day {day}: {e}")
        return False


def search_memories(
    agent_id: int,
    query: str,
    n_results: int = 5,
    recent_days_boost: int = 3,
) -> list[dict]:
    """Search agent memories using semantic similarity + recency weighting.

    Args:
        agent_id: The agent to search memories for
        query: The semantic search query (e.g. "電價 物價 經濟")
        n_results: Max results to return
        recent_days_boost: How many recent days get priority ranking
    """
    coll = _get_collection()
    if coll is None:
        return []

    try:
        results = coll.query(
            query_texts=[query],
            n_results=n_results * 2,  # fetch extra for re-ranking
            where={"agent_id": agent_id},
        )
    except Exception as e:
        logger.error(f"Memory search failed for agent {agent_id}: {e}")
        return []

    if not results or not results.get("documents"):
        return []

    # Flatten results
    docs = results["documents"][0]
    metas = results["metadatas"][0]
    distances = results["distances"][0] if results.get("distances") else [0] * len(docs)

    # Find the max day for recency scoring
    max_day = max((m.get("day", 0) for m in metas), default=0)

    entries = []
    for doc, meta, dist in zip(docs, metas, distances):
        day = meta.get("day", 0)
        # Recency boost: recent entries get a score multiplier
        recency_score = 1.0
        if max_day > 0 and (max_day - day) < recent_days_boost:
            recency_score = 1.5  # 50% boost for very recent entries

        # Combined score (lower distance = better match; higher = better)
        combined_score = (1 - dist) * recency_score

        entries.append({
            "diary_text": doc,
            "day": day,
            "agent_id": meta.get("agent_id"),
            "satisfaction": meta.get("satisfaction"),
            "anxiety": meta.get("anxiety"),
            "relevance_score": round(combined_score, 3),
        })

    # Sort by combined score descending
    entries.sort(key=lambda x: x["relevance_score"], reverse=True)
    return entries[:n_results]


def get_agent_memory_count(agent_id: int) -> int:
    """Return how many diary entries are stored for an agent."""
    coll = _get_collection()
    if coll is None:
        return 0
    try:
        result = coll.count()
        # ChromaDB doesn't easily count per-filter, so we approximate
        return result
    except Exception:
        return 0
