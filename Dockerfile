# syntax=docker/dockerfile:1.4
# <https://quay.io/repository/pypa/manylinux_2_28?tab=tags>
FROM quay.io/pypa/manylinux_2_28@sha256:6555afbd0e57fb232c5b7e4409b12dfd8ed6172ff9176641b71d4a7ee6fd57d6

LABEL org.opencontainers.image.source="https://github.com/vadimpiven/node_reqwest"
LABEL org.opencontainers.image.description="Dev Container for node_reqwest"
LABEL org.opencontainers.image.licenses="Apache-2.0 OR MIT"

ARG TARGETARCH
ARG USERNAME=runner
ARG USER_UID=1001
ARG USER_GID=$USER_UID

# Toolchain Homes (kept in image, NOT shadowed by volumes)
ENV PNPM_HOME=/home/${USERNAME}/.pnpm
ENV RUSTUP_HOME=/home/${USERNAME}/.rustup
ENV CARGO_HOME=/home/${USERNAME}/.cargo

# Cache Directions (shadowed by repo-local volumes for persistence)
ENV CACHE_ROOT=/home/${USERNAME}/.cache
ENV UV_CACHE_DIR=${CACHE_ROOT}/uv
ENV PNPM_STORE_PATH=${CACHE_ROOT}/pnpm-store
ENV CARGO_REGISTRY=${CARGO_HOME}/registry
ENV CARGO_GIT=${CARGO_HOME}/git
ENV SCCACHE_DIR=${CACHE_ROOT}/sccache

ENV PATH=${PNPM_HOME}:${CARGO_HOME}/bin:/home/${USERNAME}/.local/bin:$PATH

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# 1. System Setup (root)
RUN --mount=type=cache,target=/var/cache/yum,sharing=locked \
    # Dependency Installation
    printf '[trivy]\nname=Trivy repository\nbaseurl=https://aquasecurity.github.io/trivy-repo/rpm/releases/$basearch/\ngpgcheck=1\nenabled=1\ngpgkey=https://aquasecurity.github.io/trivy-repo/rpm/public.key\n' > /etc/yum.repos.d/trivy.repo \
    && rm -f /usr/local/bin/git-lfs \
    && yum update -y \
    && yum install -y sudo git git-lfs curl xz jq trivy \
        xorg-x11-server-Xvfb alsa-lib atk at-spi2-atk cairo cups-libs dbus-libs \
        gdk-pixbuf2 gtk3 libX11 libXcomposite libXcursor libXdamage libXext libXfixes libXi \
        libXrandr libXrender libXtst mesa-libgbm libicu libxkbcommon nss pango \
    && yum clean all \
    \
    # User Setup
    && groupadd --gid ${USER_GID} --non-unique ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} --non-unique --shell /bin/bash --create-home ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME} \
    && mkdir -p ${PNPM_HOME} ${RUSTUP_HOME} ${CARGO_HOME}/bin ${CACHE_ROOT} \
    \
    # Tool Provisioning
    && curl -sSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${TARGETARCH}" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none \
    && curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash \
    && cargo-binstall sccache -y --locked \
    && mkdir -p /mitmproxy-certs \
    && chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

# Rust caching activation
ENV RUSTC_WRAPPER=sccache

# Switch to non-root user
USER ${USERNAME}
WORKDIR /tmp/config
COPY --chown=${USERNAME}:${USERNAME} \
    pyproject.toml \
    .python-version \
    package.json \
    rust-toolchain.toml \
    docker-entrypoint.sh \
    ./

# 2. UV + Python runtime
RUN --mount=type=cache,target=${UV_CACHE_DIR},uid=${USER_UID},gid=${USER_GID},sharing=locked \
    UV_VERSION=$(yq -p toml -oy '.tool.uv."required-version"' pyproject.toml | sed 's/[^0-9.]*//g') \
    && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && uv python install --default

# 3. pnpm + Node.js
RUN --mount=type=cache,target=${PNPM_STORE_PATH},uid=${USER_UID},gid=${USER_GID},sharing=locked \
    PNPM_VERSION=$(jq -r '.engines.pnpm | ltrimstr("^")' package.json) \
    && curl -fsSL "https://get.pnpm.io/install.sh" | ENV="$HOME/.bashrc" SHELL="$(which bash)" PNPM_VERSION="$PNPM_VERSION" bash - \
    && pnpm config set store-dir "${PNPM_STORE_PATH}" \
    && NODE_VERSION=$(jq -r '.engines.node | ltrimstr("^")' package.json) \
    && pnpm env use --global "$NODE_VERSION" \
    && npm install -g npm@latest

# 4. Rust toolchain
RUN --mount=type=cache,target=${CARGO_REGISTRY},uid=${USER_UID},gid=${USER_GID},sharing=locked \
    --mount=type=cache,target=${CARGO_GIT},uid=${USER_UID},gid=${USER_GID},sharing=locked \
    rustup show \
    && rustup default "$(rustup show active-toolchain | cut -d' ' -f1)"

# Install entrypoint and cleanup
RUN chmod +x docker-entrypoint.sh \
    && mv docker-entrypoint.sh /home/runner/.local/bin/entrypoint \
    && rm -rf /tmp/config
WORKDIR /workspace

ENTRYPOINT ["/home/runner/.local/bin/entrypoint"]

VOLUME ["${UV_CACHE_DIR}"]
VOLUME ["${PNPM_STORE_PATH}"]
VOLUME ["${CARGO_REGISTRY}"]
VOLUME ["${CARGO_GIT}"]
VOLUME ["${SCCACHE_DIR}"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD uv --version \
        && python --version \
        && pnpm --version \
        && node --version \
        && rustup --version \
        && cargo --version \
        && rustc --version \
        || exit 1
