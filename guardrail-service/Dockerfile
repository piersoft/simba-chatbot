FROM python:3.11-slim

# Crea utente non-root con UID/GID FISSI 1001 per coerenza con analytics-service
RUN groupadd -g 1001 app && useradd -u 1001 -g 1001 -m -s /bin/bash app

WORKDIR /app

# Dipendenze di sistema minime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download dei modelli al build time (così il container parte veloce)
RUN python -c "from transformers import AutoTokenizer, AutoModelForSequenceClassification; \
    AutoTokenizer.from_pretrained('unitary/toxic-bert'); \
    AutoModelForSequenceClassification.from_pretrained('unitary/toxic-bert')"

RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')"

# Copy app
COPY app.py .
COPY corpus_static.json .

# Permessi: la cartella /app/data è volume-mounted, ownership gestita dal volume
RUN mkdir -p /app/data && chown -R 1001:1001 /app

USER 1001:1001

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
