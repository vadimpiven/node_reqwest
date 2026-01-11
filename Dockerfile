# syntax=docker/dockerfile:1.4
# <https://quay.io/repository/pypa/manylinux_2_28?tab=tags>
FROM quay.io/pypa/manylinux_2_28@sha256:6555afbd0e57fb232c5b7e4409b12dfd8ed6172ff9176641b71d4a7ee6fd57d6

ARG TARGETARCH
ARG USERNAME=runner
ARG USER_UID=1001
ARG USER_GID=$USER_UID

# Toolchain Homes - now in workspace for persistence
ENV MISE_DATA_DIR=/workspace/.cache/docker/mise
ENV PNPM_HOME=/home/${USERNAME}/.pnpm
ENV RUSTUP_HOME=/workspace/.cache/docker/rustup
ENV CARGO_HOME=/workspace/.cache/docker/cargo

# Cache Directories - all in workspace for persistence
ENV UV_CACHE_DIR=/workspace/.cache/docker/uv
ENV UV_PROJECT_ENVIRONMENT=/workspace/.cache/docker/venv
ENV npm_config_store_dir=/workspace/.cache/docker/pnpm-store
ENV SCCACHE_DIR=/workspace/.cache/docker/sccache

# Configure Python
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Prioritize Mise shims, then other tool paths
ENV PATH=${MISE_DATA_DIR}/shims:${PNPM_HOME}:${CARGO_HOME}/bin:/home/${USERNAME}/.local/bin:$PATH

# Container environment variables
ENV DEV_CONTAINER=1
ENV READY_MARKER=/home/${USERNAME}/.container-ready

# SSL environment variables
ENV SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt
ENV SSL_CERT_DIR=/etc/ssl/certs

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

HEALTHCHECK --interval=2s --timeout=5s --start-period=30s --retries=15 \
    CMD [ -f "$READY_MARKER" ] || exit 1

COPY .mise-version /tmp/.mise-version
RUN --mount=type=cache,target=/var/cache/yum,sharing=locked \
    MISE_VERSION=$(cat /tmp/.mise-version) \
    && rm -f /tmp/.mise-version \
    && ARCH=$([ "$TARGETARCH" = "amd64" ] && echo "x64" || echo "arm64") \
    && curl -sSL "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-${ARCH}-musl" -o /usr/local/bin/mise \
    && chmod +x /usr/local/bin/mise \
    \
    # Configure mise for glibc compatibility (forces correct Python binaries)
    && mkdir -p /etc/mise \
    && MISE_CPU=$([ "$TARGETARCH" = "amd64" ] && echo "x86_64" || echo "aarch64") \
    && echo "[settings]" > /etc/mise/config.toml \
    && echo "python.precompiled_arch = \"$MISE_CPU\"" >> /etc/mise/config.toml \
    && echo "python.precompiled_os = \"unknown-linux-gnu\"" >> /etc/mise/config.toml \
    \
    # Install rustup
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain none \
    \
    # Dependency Installation
    && rm -f /usr/local/bin/git-lfs \
    && dnf update -y \
    && dnf install -y sudo git git-lfs curl \
        xorg-x11-server-Xvfb alsa-lib atk at-spi2-atk cairo cups-libs dbus-libs \
        gdk-pixbuf2 gtk3 libX11 libXcomposite libXcursor libXdamage libXext libXfixes libXi \
        libXrandr libXrender libXtst mesa-libgbm libicu libxkbcommon nss pango \
    && dnf clean all \
    \
    # Create SSL symlinks (for tools that expect /etc/ssl/certs or Python internal certs)
    && mkdir -p ${SSL_CERT_DIR} \
    && ln -sf ${SSL_CERT_FILE} ${SSL_CERT_DIR}/ca-certificates.crt \
    && ln -sf ${SSL_CERT_FILE} /opt/_internal/certs.pem \
    \
    # User Setup
    && groupadd --gid ${USER_GID} --non-unique ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} --non-unique --shell /bin/bash --create-home ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME} \
    && mkdir -p ${MISE_DATA_DIR} ${PNPM_HOME} ${RUSTUP_HOME} ${CARGO_HOME} \
    && mkdir -p /mitmproxy-certs \
    && printf '%s\n' \
        '# Wait for container initialization before proceeding' \
        'while [ ! -f "$READY_MARKER" ]; do sleep 0.1; done' \
        'source /etc/environment' \
        'eval "$(mise activate bash)"' \
        >> /home/${USERNAME}/.bashrc \
    && chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

# Switch to non-root user
USER ${USERNAME}
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint"]
WORKDIR /workspace
