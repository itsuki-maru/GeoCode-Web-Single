FROM rust:latest

RUN apt update && apt install -y curl pkg-config libssl-dev && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs && apt clean

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

RUN cargo install sqlx-cli --no-default-features --features sqlite

RUN sqlx database create && sqlx migrate run && cargo sqlx prepare

RUN cargo build --release

CMD ["/bin/sh"]
