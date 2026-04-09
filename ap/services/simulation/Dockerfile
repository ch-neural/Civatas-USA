FROM python:3.11-slim

# System deps for cairocffi (required by igraph/OASIS)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libcairo2-dev pkg-config gcc && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/simulation/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

COPY shared/ ./shared/
COPY services/simulation/app/ ./app/

# OASIS source will be mounted at /opt/oasis via docker-compose
ENV PYTHONPATH="/opt/oasis:${PYTHONPATH}"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
