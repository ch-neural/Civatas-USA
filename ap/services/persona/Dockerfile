FROM python:3.11-slim

WORKDIR /app

COPY services/persona/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

COPY shared/ ./shared/
COPY services/persona/app/ ./app/

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
