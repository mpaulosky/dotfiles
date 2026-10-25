# The Sandcastle sandbox: the tools the repo's gate (scripts/gate.sh) runs, Claude
# Code, and pnpm for .sandcastle/ itself. trixie, not bookworm: git 2.40 or later.
FROM node:22-trixie

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  python3 \
  python3-pip \
  libicu76 \
  && rm -rf /var/lib/apt/lists/*

# The Python tools: yamllint, which the gate runs on the YAML a branch changes,
# and pytest for the tests of the scripts under .github/scripts. The gate skips
# yamllint when it's missing, so the sandbox would pass a branch CI fails.
ARG YAMLLINT_VERSION=1.38.0
RUN pip3 install --no-cache-dir --break-system-packages \
    pytest pyyaml "yamllint==${YAMLLINT_VERSION}"

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# The workflow and shell linters the gate runs. Without them it skips their
# checks, so the sandbox would pass a branch CI fails. The versions match
# scripts/gate.sh's, and each download is checked against the SHA-256 the
# project publishes for it: change both together.
ARG ACTIONLINT_VERSION=1.7.12
ARG SHELLCHECK_VERSION=v0.11.0
ARG ZIZMOR_VERSION=1.30.1
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) \
      actionlint_arch=amd64; actionlint_sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8; \
      shellcheck_arch=x86_64; shellcheck_sha=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6; \
      zizmor_arch=x86_64; zizmor_sha=e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a ;; \
    arm64) \
      actionlint_arch=arm64; actionlint_sha=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6; \
      shellcheck_arch=aarch64; shellcheck_sha=68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc; \
      zizmor_arch=aarch64; zizmor_sha=7ff1dce33bdd18fd2a4affe63bdd47efcccca97b2cec1c1863ec26e9e2647540 ;; \
    *) echo "No linter binaries for $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  cd /tmp; \
  curl -fsSLo actionlint.tar.gz "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_${actionlint_arch}.tar.gz"; \
  curl -fsSLo shellcheck.tar.gz "https://github.com/koalaman/shellcheck/releases/download/${SHELLCHECK_VERSION}/shellcheck-${SHELLCHECK_VERSION}.linux.${shellcheck_arch}.tar.gz"; \
  curl -fsSLo zizmor.tar.gz "https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-${zizmor_arch}-unknown-linux-gnu.tar.gz"; \
  printf '%s  %s\n' "$actionlint_sha" actionlint.tar.gz "$shellcheck_sha" shellcheck.tar.gz "$zizmor_sha" zizmor.tar.gz | sha256sum -c -; \
  tar -xzf actionlint.tar.gz -C /usr/local/bin actionlint; \
  tar -xzf shellcheck.tar.gz --strip-components=1 -C /usr/local/bin "shellcheck-${SHELLCHECK_VERSION}/shellcheck"; \
  tar -xzf zizmor.tar.gz -C /usr/local/bin zizmor; \
  rm actionlint.tar.gz shellcheck.tar.gz zizmor.tar.gz; \
  actionlint -version; shellcheck --version; zizmor --version

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# pnpm through corepack, at the version package.json's "packageManager" pins.
RUN corepack enable pnpm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The .NET SDK the gate builds with (scripts/gate.sh runs dotnet build and test). The channel is global.json's
# sdk.version, major and minor; set INSTALL_DOTNET=false for a repo with no solution.
ARG INSTALL_DOTNET=true
ARG DOTNET_CHANNEL=10.0
RUN if [ "$INSTALL_DOTNET" = true ]; then \
      curl -fsSLo /tmp/dotnet-install.sh https://dot.net/v1/dotnet-install.sh \
      && bash /tmp/dotnet-install.sh --channel "$DOTNET_CHANNEL" --install-dir /usr/share/dotnet \
      && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet && rm /tmp/dotnet-install.sh; \
    fi
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# The host's skills are mounted under ~/.claude/skills (lib/skills.mts). Made
# here so the agent owns ~/.claude, rather than Docker creating it as root for
# the mounts, which would leave Claude Code unable to write its config.
RUN mkdir -p /home/agent/.claude/skills

# markdownlint-cli2, which the gate runs from PATH, at the version gate.sh
# pins, installed globally with pnpm (never npm) into the agent's home.
ENV PNPM_HOME="/home/agent/.local/share/pnpm"
ENV PATH="/home/agent/.local/bin:${PNPM_HOME}/bin:$PATH"
ARG MARKDOWNLINT_CLI2_VERSION=0.23.3
RUN cd /tmp && pnpm add -g "markdownlint-cli2@${MARKDOWNLINT_CLI2_VERSION}" && command -v markdownlint-cli2

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
