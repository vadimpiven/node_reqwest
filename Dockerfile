# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# <https://quay.io/repository/pypa/manylinux_2_28?tab=tags>
FROM quay.io/pypa/manylinux_2_28@sha256:f942fe46374fc45cc597affd63305edabc61b638138a60f75f95198b22419dfa

ARG TARGETARCH
ARG CONTAINER_USER=runner
ARG USER_UID=1001
ARG USER_GID=$USER_UID

# Container environment variables
ENV MISE_ENV=docker
ENV MISE_TRUSTED_CONFIG_PATHS=/workspace
ENV MISE_DATA_DIR=/workspace/.cache/docker/mise
ENV READY_MARKER=/home/${CONTAINER_USER}/.container-ready

# SSL environment variables
ENV SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt
ENV SSL_CERT_DIR=/etc/ssl/certs

HEALTHCHECK --interval=10s --timeout=5s --start-period=180s --retries=3 \
    CMD ["bash", "-c", "test -f \"$READY_MARKER\""]

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
COPY .mise-version /tmp/.mise-version
# hadolint ignore=DL3041,SC2016
RUN --mount=type=cache,target=/var/cache/dnf,sharing=locked \
    # Install mise (musl binary, statically linked)
    MISE_VERSION=$(cat /tmp/.mise-version) \
    && rm -f /tmp/.mise-version \
    && MISE_ARCH=$([ "$TARGETARCH" = "amd64" ] && echo "x64" || echo "arm64") \
    && curl -sSL "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-${MISE_ARCH}-musl" -o /usr/local/bin/mise \
    && chmod +x /usr/local/bin/mise \
    \
    # Dependency Installation
    && rm -f /usr/local/bin/git-lfs \
    && dnf update -y \
    && dnf install -y --setopt=install_weak_deps=False \
    alsa-lib \
    at-spi2-atk \
    atk \
    cairo \
    dbus-libs \
    gdk-pixbuf2 \
    git \
    gtk3 \
    libicu \
    libX11 \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXext \
    libXfixes \
    libXi \
    libXrandr \
    libXrender \
    libxkbcommon \
    libXtst \
    mesa-libgbm \
    nss \
    pango \
    sudo \
    xorg-x11-server-Xvfb \
    && dnf clean all \
    \
    # Create SSL symlinks
    && mkdir -p ${SSL_CERT_DIR} \
    && ln -sf ${SSL_CERT_FILE} ${SSL_CERT_DIR}/ca-certificates.crt \
    && ln -sf ${SSL_CERT_FILE} /opt/_internal/certs.pem \
    \
    # User Setup
    && groupadd --gid ${USER_GID} --non-unique ${CONTAINER_USER} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} --non-unique --shell /bin/bash --create-home ${CONTAINER_USER} \
    && echo "${CONTAINER_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${CONTAINER_USER} \
    && chmod 0440 /etc/sudoers.d/${CONTAINER_USER} \
    && mkdir -p /mitmproxy-certs \
    && printf '%s\n' \
    '# Global Bash initialization (sourced by BASH_ENV and .bashrc)' \
    'if [ -n "${READY_MARKER:-}" ] && [ "${ENTRYPOINT:-}" != "true" ]; then' \
    '  while [ ! -f "$READY_MARKER" ]; do sleep 0.5; done' \
    'fi' \
    'eval "$(mise activate bash)"' \
    > /etc/bash-entrypoint.sh \
    && chmod +x /etc/bash-entrypoint.sh \
    && echo ". /etc/bash-entrypoint.sh" >> /home/${CONTAINER_USER}/.bashrc \
    && chown ${CONTAINER_USER}:${CONTAINER_USER} /home/${CONTAINER_USER}/.bashrc \
    && chown -R ${CONTAINER_USER}:${CONTAINER_USER} /home/${CONTAINER_USER}

ENV BASH_ENV=/etc/bash-entrypoint.sh

USER ${CONTAINER_USER}
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/entrypoint
ENTRYPOINT ["env", "ENTRYPOINT=true", "/usr/local/bin/entrypoint"]
WORKDIR /workspace
