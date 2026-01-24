# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# <https://quay.io/repository/pypa/manylinux_2_28?tab=tags>
FROM quay.io/pypa/manylinux_2_28@sha256:553fe81d74eb4f2be0901928c4c3af50ca6562b75741f45911770a00630650f0

ARG TARGETARCH
ARG USERNAME=runner
ARG USER_UID=1001
ARG USER_GID=$USER_UID

# Container environment variables
ENV MISE_ENV=docker
ENV MISE_TRUSTED_CONFIG_PATHS=/workspace
ENV MISE_DATA_DIR=/workspace/.cache/docker/mise
ENV READY_MARKER=/home/${USERNAME}/.container-ready

# SSL environment variables
ENV SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt
ENV SSL_CERT_DIR=/etc/ssl/certs

HEALTHCHECK --interval=10s --timeout=5s --start-period=180s --retries=3 \
    CMD [ -f "$READY_MARKER" ] || exit 1

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
    && groupadd --gid ${USER_GID} --non-unique ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} --non-unique --shell /bin/bash --create-home ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME} \
    && mkdir -p /mitmproxy-certs \
    && printf '%s\n' \
    '# Global Bash initialization (sourced by BASH_ENV and .bashrc)' \
    'if [ -n "${READY_MARKER:-}" ] && [ "${ENTRYPOINT:-}" != "true" ]; then' \
    '  while [ ! -f "$READY_MARKER" ]; do sleep 0.5; done' \
    'fi' \
    'eval "$(mise activate bash)"' \
    > /etc/bash-entrypoint.sh \
    && chmod +x /etc/bash-entrypoint.sh \
    && echo ". /etc/bash-entrypoint.sh" >> /home/${USERNAME}/.bashrc \
    && chown ${USERNAME}:${USERNAME} /home/${USERNAME}/.bashrc \
    && chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

ENV BASH_ENV=/etc/bash-entrypoint.sh

USER ${USERNAME}
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/entrypoint
ENTRYPOINT ["env", "ENTRYPOINT=true", "/usr/local/bin/entrypoint"]
WORKDIR /workspace
