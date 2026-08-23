ARG BUILD_DIR=/build
# Declared so legacy `docker build` accepts --build-arg BUILDPLATFORM=…;
# BuildKit still supplies its builtin value in CI.
ARG BUILDPLATFORM

# Build Container
FROM --platform=$BUILDPLATFORM node:24-alpine AS build

ARG BUILD_DIR

RUN mkdir ${BUILD_DIR}
WORKDIR ${BUILD_DIR}

COPY .htmlnanorc \
    package.json \
    package-lock.json \
    postcss.config.js \
    tailwind.config.js \
    vite.config.js \
    ./

RUN npm ci

COPY client ./client
RUN npm run build

# Runtime Container
FROM denoland/deno:alpine

ARG BUILD_DIR

ENV PUID=1000
ENV PGID=1000
ENV EXEC_TOOL=su-exec
ENV GLOBNOTES_HOST=0.0.0.0
ENV GLOBNOTES_PORT=8080

ENV APP_PATH=/app
ENV GLOBNOTES_PATH=/data
ENV DENO_DIR=/deno-dir

RUN mkdir -p ${APP_PATH}
RUN mkdir -p ${GLOBNOTES_PATH}

RUN apk update && apk add --no-cache \
    su-exec \
    && rm -rf /var/cache/apk/*

WORKDIR ${APP_PATH}

COPY LICENSE THIRD-PARTY-NOTICES.md deno.json deno.lock package.json ./
COPY server ./server
COPY plugins ./plugins

# Vendor every runtime dependency (npm + jsr) into the image so the
# container never fetches at runtime (deno runs with --cached-only).
RUN deno install && deno cache server/main.ts && chmod -R a+rX ${APP_PATH} ${DENO_DIR}

COPY --from=build ${BUILD_DIR}/client/dist ./client/dist

COPY entrypoint.sh healthcheck.sh /
RUN chmod +x /entrypoint.sh /healthcheck.sh

VOLUME /data
EXPOSE ${GLOBNOTES_PORT}/tcp
HEALTHCHECK --interval=60s --timeout=10s CMD /healthcheck.sh

ENTRYPOINT [ "/entrypoint.sh" ]
