FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.2.2 && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build && pnpm prune --prod

FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS runtime

ARG APP_UID=501
ARG APP_GID=20
ARG CODEX_VERSION=0.144.4

ENV NODE_ENV=production \
    HOME=/home/workautomation \
    CODEX_HOME=/home/workautomation/.codex

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      openssh-client \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}" pnpm@11.2.2 \
    && group_name="$(getent group "${APP_GID}" | cut -d: -f1)" \
    && if [ -z "${group_name}" ]; then groupadd --gid "${APP_GID}" workautomation; group_name=workautomation; fi \
    && useradd --uid "${APP_UID}" --gid "${group_name}" --create-home --shell /bin/bash workautomation \
    && mkdir -p /Applications/ChatGPT.app/Contents/Resources \
    && ln -s /usr/local/bin/codex /Applications/ChatGPT.app/Contents/Resources/codex

WORKDIR /app

COPY --from=builder --chown=workautomation:${APP_GID} /app/package.json ./package.json
COPY --from=builder --chown=workautomation:${APP_GID} /app/node_modules ./node_modules
COPY --from=builder --chown=workautomation:${APP_GID} /app/dist ./dist
COPY --from=builder --chown=workautomation:${APP_GID} /app/src/server ./src/server
COPY --from=builder --chown=workautomation:${APP_GID} /app/prompts ./prompts

RUN mkdir -p /app/.linear-automation /home/workautomation/.codex \
    && chown -R workautomation:${APP_GID} /app /home/workautomation

USER workautomation

EXPOSE 4378

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD curl --fail --silent --show-error http://127.0.0.1:4378/api/daemon/status >/dev/null || exit 1

CMD ["node", "src/server/index.mjs", "--config", "/workspace/config.local.json"]
