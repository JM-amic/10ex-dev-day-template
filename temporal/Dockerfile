FROM mcr.microsoft.com/mirror/docker/library/python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

CMD ["python", "-m", "src.worker"]
