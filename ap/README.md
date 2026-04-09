# Civatas

**Universal Social Simulation Agent Generation Platform**
通用型社會模擬 Agent 生成平台

## Overview

Civatas lets users upload real-world demographic statistics for **any region**,
generates a synthetic population of AI agents matching those distributions,
and feeds them into the [OASIS](https://github.com/camel-ai/oasis) simulation
engine to run social simulations such as election polls, opinion dynamics, and
policy impact studies.

## Architecture

The system is composed of **9 Docker services**, each handling a distinct layer:

| Service | Port | Description |
|---------|------|-------------|
| `web` | 3000 | Next.js frontend — upload data, configure, view results |
| `api` | 8000 | FastAPI gateway — orchestrates all downstream services |
| `ingestion` | 8001 | Parses uploaded CSV / JSON / Excel into internal format |
| `synthesis` | 8002 | Generates synthetic population from statistical distributions |
| `persona` | 8003 | Enriches structured records into natural-language personas |
| `social` | 8004 | Builds follow graphs with homophily bias *(optional)* |
| `adapter` | 8005 | Exports agents to OASIS-compatible CSV / JSON |
| `simulation` | 8006 | Runs OASIS simulations *(optional, requires OASIS)* |
| `analytics` | 8007 | Analyzes simulation results from OASIS `.db` files *(optional)* |

## Quick Start

```bash
# 1. Copy and edit environment variables
cp .env.example .env

# 2. Start core services (web + api + ingestion + synthesis + persona + adapter)
docker compose up --build

# 3. Start all services including simulation & analytics
docker compose --profile full up --build
```

- Web UI: http://localhost:3000
- API docs: http://localhost:8000/docs

## i18n

Default locale: `zh-TW` (Traditional Chinese).

Supported locales:
- `zh-TW` — 繁體中文
- `en` — English

Translation files: `shared/i18n/locales/`

## Project Structure

```
ap/
├── docker-compose.yml
├── .env.example
├── shared/                  # Shared schemas & i18n
│   ├── schemas/
│   └── i18n/locales/
├── services/
│   ├── web/                 # Next.js frontend
│   ├── api/                 # FastAPI gateway
│   ├── ingestion/           # Layer 1: Data parsing
│   ├── synthesis/           # Layer 2: Population synthesis
│   ├── persona/             # Layer 3: Persona generation
│   ├── social/              # Layer 4: Social graph
│   ├── adapter/             # Layer 5: OASIS format export
│   ├── simulation/          # Layer 6: OASIS runner
│   └── analytics/           # Layer 7: Result analysis
├── templates/               # Built-in demographic templates
├── uploads/                 # User uploaded files
└── outputs/                 # Generated agents & simulation results
```

## License

TBD
