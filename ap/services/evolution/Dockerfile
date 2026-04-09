FROM python:3.11-slim

WORKDIR /app

COPY services/evolution/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Install Playwright Chromium + ALL required OS-level deps automatically
RUN playwright install --with-deps chromium

# Pre-download ChromaDB ONNX embedding model (79MB) so it's baked into
# the image and won't need to be fetched at runtime.
RUN python -c "\
from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2; \
ONNXMiniLM_L6_V2()"

COPY shared /app/shared
COPY services/evolution/app /app/app

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
