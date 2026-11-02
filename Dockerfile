FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY docs ./docs
COPY examples ./examples

# Retain metadata only for the Alpine libraries copied into the scratch image.
# This lets SBOM/CVE scanners identify them without shipping apk or a shell.
RUN mkdir -p /runtime-metadata/lib/apk/db && \
    awk 'BEGIN { RS=""; ORS="\n\n" } /\nP:(musl|libgcc|libstdc\+\+|ca-certificates-bundle)\n/ { print }' \
      /lib/apk/db/installed > /runtime-metadata/lib/apk/db/installed

FROM scratch

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MAX_XML_BYTES=262144

WORKDIR /app

COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /lib/ld-musl-*.so.1 /lib/
COPY --from=runtime /usr/lib/libstdc++.so.6 /usr/lib/
COPY --from=runtime /usr/lib/libgcc_s.so.1 /usr/lib/
COPY --from=runtime /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=runtime /etc/os-release /etc/os-release
COPY --from=runtime /etc/alpine-release /etc/alpine-release
COPY --from=runtime /runtime-metadata/ /
COPY --from=runtime --chown=1000:1000 /app /app

USER 1000:1000
EXPOSE 3000

CMD ["node", "src/server.js"]
