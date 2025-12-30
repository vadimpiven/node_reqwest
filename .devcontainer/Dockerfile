# syntax=docker/dockerfile:1.4
ARG TARGETARCH
# <https://quay.io/repository/pypa/manylinux_2_28_x86_64?tab=tags>
FROM quay.io/pypa/manylinux_2_28_x86_64@sha256:f324fa59bb7a33b4c421fdeaa3d66e9c941cd66b736124c59366062e237f8a5f AS base-amd64
# <https://quay.io/repository/pypa/manylinux_2_28_aarch64?tab=tags>
FROM quay.io/pypa/manylinux_2_28_aarch64@sha256:eed90f5453063780db25d09786d4f23556120f8a96e21146ed0cf0f11f3cbee4 AS base-arm64
FROM base-${TARGETARCH}

LABEL org.opencontainers.image.source="https://github.com/vadimpiven/node_reqwest"
LABEL org.opencontainers.image.description="Dev Container for node_reqwest"
LABEL org.opencontainers.image.licenses="Apache-2.0 OR MIT"

HEALTHCHECK NONE

ARG TARGETARCH
ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# Consolidated Environment Setup
ENV PNPM_HOME=/home/${USERNAME}/.local/share/pnpm \
    RUSTUP_HOME=/home/${USERNAME}/.rustup \
    CARGO_HOME=/home/${USERNAME}/.cargo \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

ENV PATH=${PNPM_HOME}:/home/${USERNAME}/.local/bin:${CARGO_HOME}/bin:$PATH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# 1. System Setup (root)
RUN --mount=type=cache,target=/var/cache/yum,sharing=locked \
    # Dependency Installation
    rm -f /usr/local/bin/git-lfs && \
    yum update -y && \
    yum install -y sudo git git-lfs curl xz jq \
    xorg-x11-server-Xvfb alsa-lib atk at-spi2-atk cairo cups-libs dbus-libs \
    gdk-pixbuf2 gtk3 libX11 libXcomposite libXcursor libXdamage libXext libXfixes libXi \
    libXrandr libXrender libXtst mesa-libgbm libicu libxkbcommon nss pango && \
    yum clean all && \
    \
    # User Setup
    groupadd --gid ${USER_GID} ${USERNAME} && \
    useradd --uid ${USER_UID} --gid ${USER_GID} --shell /bin/bash --create-home ${USERNAME} && \
    echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} && \
    chmod 0440 /etc/sudoers.d/${USERNAME} && \
    \
    # Tool Provisioning
    curl -sSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${TARGETARCH}" -o /usr/local/bin/yq && \
    chmod +x /usr/local/bin/yq && \
    mkdir -p ${PNPM_HOME} ${RUSTUP_HOME} ${CARGO_HOME}/bin /home/${USERNAME}/.cache && \
    curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none && \
    curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash && \
    chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

# Switch to non-root user
USER ${USERNAME}
WORKDIR /tmp/config
COPY --chown=${USERNAME}:${USERNAME} package.json pnpm-workspace.yaml rust-toolchain.toml .python-version pyproject.toml ./

# 2. UV + Python runtime
RUN --mount=type=cache,target=/home/${USERNAME}/.cache/uv,uid=${USER_UID},gid=${USER_GID},sharing=locked \
    UV_VERSION=$(yq -p toml -oy '.tool.uv."required-version"' pyproject.toml | sed 's/[^0-9.]*//g') && \
    curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh && \
    uv python install --default

# 3. pnpm + Node.js
RUN --mount=type=cache,target=/home/${USERNAME}/.pnpm-store,uid=${USER_UID},gid=${USER_GID},sharing=locked \
    PNPM_VERSION=$(jq -r '.engines.pnpm | ltrimstr("^")' package.json) && \
    curl -fsSL "https://get.pnpm.io/install.sh" | ENV="$HOME/.bashrc" SHELL="$(which bash)" PNPM_VERSION="$PNPM_VERSION" bash - && \
    pnpm config set store-dir /home/${USERNAME}/.pnpm-store && \
    NODE_VERSION=$(jq -r '.engines.node | ltrimstr("^")' package.json) && \
    pnpm env use --global "$NODE_VERSION" && \
    npm install -g npm@latest

# 4. Rust toolchain
RUN --mount=type=cache,target=/home/${USERNAME}/.cargo/registry,uid=${USER_UID},gid=${USER_GID},sharing=locked \
    --mount=type=cache,target=/home/${USERNAME}/.cargo/git,uid=${USER_UID},gid=${USER_GID},sharing=locked \
    rustup show && \
    rustup default "$(rustup show active-toolchain | cut -d' ' -f1)"

RUN rm -rf /tmp/config
WORKDIR /workspace
