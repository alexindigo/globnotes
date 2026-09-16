# Devcontainer base: the same deno version the repo's production image
# builds with (Dockerfile build stage). Adds a `vscode` user at the host
# user's uid (1000) — the CLI's updateRemoteUserUID helper failed to
# build, and uid-1000-in-image makes mounted writes land as the host
# user without that step.
FROM denoland/deno:2.9.6

RUN groupadd --gid 1000 vscode \
    && useradd --uid 1000 --gid vscode --shell /bin/bash vscode
