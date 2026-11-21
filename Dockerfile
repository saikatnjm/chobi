# Chobi: small image (~60 MB). Python stdlib app + Pillow for 20 KB poster thumbnails.
FROM python:3.13-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CHOBI_DATA=/data \
    CHOBI_IN_DOCKER=1

RUN pip install --no-cache-dir pillow==11.3.0 \
 && adduser -D -u 1000 chobi \
 && mkdir -p /data && chown chobi:chobi /data

WORKDIR /app
COPY --chown=chobi:chobi . .

USER chobi
VOLUME ["/data"]
EXPOSE 8090

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:8090/ || exit 1

CMD ["python", "server.py", "--bind", "0.0.0.0", "--port", "8090"]
