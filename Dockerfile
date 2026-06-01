# syntax=docker/dockerfile:1

# ---- Stage 1: build the React/Vite frontend ----
# Node is only needed here. Vite emits to /app/static/dist (see vite.config.ts).
FROM node:22-alpine AS web
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# ---- Stage 2: runtime (Python stdlib only, no pip deps) ----
FROM python:3.12-slim
WORKDIR /app

# Backend + legacy static assets the server still serves under /static/*
COPY server.py ./
COPY static/ ./static/
COPY dashboard.legacy.html ./

# Compiled SPA from the builder stage -> served at /static/dist/index.html
COPY --from=web /app/static/dist ./static/dist

# Cache dir for data.json / history.jsonl (mounted as emptyDir or PVC in k8s)
RUN mkdir -p /app/data

ENV PORT=8765
EXPOSE 8765

# Drop root
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app \
  && chown -R app:app /app
USER app

CMD ["python3", "server.py"]
