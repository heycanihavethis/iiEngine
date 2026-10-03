FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/api/pyproject.toml ./
COPY services/api/requirements-dev.lock ./
COPY services/api/ii_api ./ii_api
RUN python -m pip install --no-cache-dir --upgrade pip==26.2.1 && pip install --no-cache-dir -c requirements-dev.lock . && useradd --create-home engine
COPY services/api/alembic.ini ./
COPY services/api/migrations ./migrations
USER engine
EXPOSE 8000
CMD ["sh", "-c", "uvicorn ii_api.main:app --host 0.0.0.0 --port ${PORT:-8000} --no-access-log"]
