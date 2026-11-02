FROM docker.io/denoland/deno:2.9.6

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 dev \
    && useradd --create-home --uid 1000 --gid dev --shell /bin/bash dev \
    && mkdir -p /deno-dir /workspace /home/dev/.cache \
    && ln -s /deno-dir /home/dev/.cache/deno \
    && chown dev:dev /deno-dir /workspace /home/dev/.cache

USER dev
WORKDIR /workspace
