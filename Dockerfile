# Cloud Run image. Small on purpose: the app is a few hundred lines of Python
# and a static page, and every megabyte here is cold-start latency you pay for
# on a service that scales to zero between drafts.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first, so a change to the app does not re-resolve the wheel set.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --no-cache-dir --no-deps -e .

COPY web/ ./web/
COPY data/ ./data/

# Cloud Run sends traffic to $PORT and expects the container to listen on every
# interface. The loopback default that protects a laptop would refuse it.
ENV HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080

# Run as a non-root user; nothing here needs to write to the filesystem.
RUN useradd --create-home --uid 1000 app && chown -R app:app /app
USER app

CMD exec uvicorn projections.server:app --host 0.0.0.0 --port ${PORT} --log-level warning
