FROM docker.io/library/archlinux:base

RUN pacman -Syu --noconfirm chromium \
    && pacman -Scc --noconfirm \
    && groupadd --gid 1000 chromium \
    && useradd --create-home --uid 1000 --gid chromium chromium

USER chromium
ENTRYPOINT ["chromium", "--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9335", "--user-data-dir=/run-tmp/chromium-profile", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--password-store=basic", "--window-size=1280,900"]
CMD ["about:blank"]
