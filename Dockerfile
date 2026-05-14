FROM rust:latest

RUN apt update && apt install -y \
    build-essential \
    curl \
    pkg-config \
    libssl-dev \
    libgtk-3-dev \
    libsoup-3.0-dev \
    libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt install -y nodejs \
    && apt clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /web

ENV DATABASE_URL=sqlite:/web/geocode_web.sqlite
ENV CREATEDATABASE_PATH=/web/geocode_web.sqlite
ENV VITE_IP_ADDRESS=
ENV VITE_ASSET_PATH=/assets/

COPY . .

WORKDIR /web/src_frontend/scripts

RUN chmod +x frontends-builder.sh && ./frontends-builder.sh

WORKDIR /web

RUN rustc --version && cargo --version && node --version && npm --version

RUN cargo install sqlx-cli

RUN cargo install tauri-cli --version "^2.0.0" --locked

RUN sqlx database create

RUN sqlx migrate run

RUN cargo sqlx prepare

RUN cargo tauri build

CMD ["/bin/sh"]
