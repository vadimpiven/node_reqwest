# syntax=docker/dockerfile:1.4
ARG TARGETARCH
FROM quay.io/pypa/manylinux_2_28_x86_64 AS base-amd64
FROM quay.io/pypa/manylinux_2_28_aarch64 AS base-arm64
FROM base-${TARGETARCH}
ARG TARGETARCH

COPY package.json pnpm-workspace.yaml rust-toolchain.toml .python-version pyproject.toml /tmp/config/

# System deps + jq (JSON) + yq (YAML/TOML)
RUN yum install -y git curl xz jq && \
    curl -sSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${TARGETARCH}" -o /usr/local/bin/yq && \
    chmod +x /usr/local/bin/yq

# UV + Python runtime (least frequently changed)
RUN UV_VERSION=$(yq -p toml -oy '.tool.uv."required-version"' /tmp/config/pyproject.toml | sed 's/[^0-9.]*//g') && \
    curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh
ENV PATH=/root/.local/bin:$PATH
RUN cd /tmp/config && uv python install --default

# pnpm (standalone install)
RUN PNPM_VERSION=$(jq -r '.engines.pnpm | ltrimstr("^")' /tmp/config/package.json) && \
    curl -fsSL "https://get.pnpm.io/install.sh" | ENV="$HOME/.bashrc" SHELL="$(which bash)" PNPM_VERSION="$PNPM_VERSION" bash -
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN pnpm config set store-dir /root/.pnpm-store

# Node.js (via pnpm env)
RUN NODE_VERSION=$(jq -r '.engines.node | ltrimstr("^")' /tmp/config/package.json) && \
    pnpm env use --global "$NODE_VERSION"

# RHEL equivalent of playwright install-deps
RUN yum install -y xorg-x11-server-Xvfb alsa-lib atk at-spi2-atk cairo cups-libs dbus-libs \
    gdk-pixbuf2 gtk3 libX11 libXcomposite libXcursor libXdamage libXext libXfixes libXi \
    libXrandr libXrender libXtst mesa-libgbm libicu libxkbcommon nss pango && \
    yum clean all && rm -rf /var/cache/yum

# Rust (last because nightly version changes frequently)
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none && \
    cd /tmp/config && rustup show && \
    rustup default "$(rustup show active-toolchain | cut -d' ' -f1)"

# cargo-binstall + cargo-run-bin (other tools installed at runtime via cargo bin)
RUN curl -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash && \
    cargo binstall cargo-run-bin -y --locked

RUN rm -rf /tmp/config
WORKDIR /workspace
