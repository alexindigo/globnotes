# Releasing

## Release identity

The tracked root `VERSION` file is the release version: `MAJOR.MINOR` or
`MAJOR.MINOR.PATCH` digits, for example `2.3.2`.

1. Bump `VERSION` in the release's changelog commit, **before** tagging.
2. Tag that commit `v` + the contents of `VERSION` (for example `v2.3.2`).

Development commits keep the last release's value. Git tags and commit counts
never choose or increment the version.

The Docker release workflow runs `scripts/check-release-version.sh <tag>` before
building and refuses to publish a tag that does not equal `v` + `VERSION`. It
builds the images with `GLOBNOTES_REVISION` set to the tagged commit.

For a `v2.3.3` release, both Docker Hub (`alexindigo/globnotes`) and GHCR
(`ghcr.io/alexindigo/globnotes`) publish the exact `2.3.3` tag and update these
moving tags to the same image:

| # | Tag | Tracks |
|---|---|---|
| 1 | `2` | Latest release in major version 2 |
| 2 | `2.3` | Latest release in minor version 2.3 |
| 3 | `latest` | Latest release |

## What the running app shows

The server reads `VERSION` once at startup; a missing or invalid file stops
startup with an error naming the file. It logs the version before the
"listening" line, returns it from `/_/api/config`, and the Settings window shows
it beside its title.

The commit is shown next to the version when the build supplies it through
`GLOBNOTES_REVISION` (7–40 lowercase hex characters):

| Build | Shown as |
|---|---|
| With a revision (release images) | `v2.3.2 (85dbf7a)` |
| Without one (source runs, local images) | `v2.3.2-dev` |

Local images can supply one with
`docker build --build-arg GLOBNOTES_REVISION=$(git rev-parse HEAD) .`.
