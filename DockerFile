# Etapa 1: Compilar librespot actualizado desde Rust
FROM rust:1-slim-bookworm AS librespot-builder
RUN apt-get update && apt-get install -y \
    build-essential \
    pkg-config \
    libasound2-dev \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install librespot

# Etapa 2: Imagen ligera con Node.js + FFmpeg + librespot
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=librespot-builder /usr/local/cargo/bin/librespot /usr/local/bin/librespot

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./
RUN mkdir -p /app/data/users

CMD ["npm", "start"]