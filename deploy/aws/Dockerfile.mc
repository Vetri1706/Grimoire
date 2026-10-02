# syntax=docker/dockerfile:1
# Official mc release RELEASE.2025-08-13T08-35-41Z, pinned to its source commit.
# Build off-host; this administrative image runs only through the tools profile.
ARG GO_IMAGE=golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195
FROM ${GO_IMAGE} AS build
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2
WORKDIR /src
RUN git init . \
    && git remote add origin https://github.com/minio/mc.git \
    && git fetch --depth=1 origin "${MC_COMMIT}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${MC_COMMIT}" \
    && go mod download \
    && go mod verify \
    && mkdir -p /out/notices \
    && go build -p 2 -mod=readonly -trimpath \
        -ldflags "$(go run buildscripts/gen-ldflags.go 2025-08-13T08:35:41Z)" \
        -o /out/mc . \
    && /out/mc --version \
    && cp LICENSE /out/notices/LICENSE \
    && if [ -f CREDITS ]; then cp CREDITS /out/notices/CREDITS; fi \
    && git archive --format=tar.gz --prefix=mc/ HEAD > /out/notices/upstream-source.tar.gz \
    && printf '%s\n' "Upstream release: RELEASE.2025-08-13T08-35-41Z" \
        "Source commit: ${MC_COMMIT}" \
        'Unmodified upstream source; locally compiled distribution.' > /out/notices/SOURCE.txt

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10002 minio \
    && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin minio \
    && mkdir -p /home/minio \
    && chown 10002:10002 /home/minio
COPY --from=build /out/mc /usr/local/bin/mc
COPY --from=build /out/notices/ /usr/share/doc/mc/
LABEL org.opencontainers.image.title="Grimoire private storage administration" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      io.grimoire.upstream.source="https://github.com/minio/mc" \
      io.grimoire.upstream.revision="7394ce0dd2a80935aded936b09fa12cbb3cb8096"
USER 10002:10002
ENV HOME=/home/minio
ENTRYPOINT ["/usr/local/bin/mc"]
