FROM mcr.microsoft.com/mirror/docker/library/python:3.11-slim

WORKDIR /app
COPY server.py .

HEALTHCHECK --interval=2s --timeout=2s --retries=15 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:9000/', timeout=2)"

CMD ["python", "server.py"]
