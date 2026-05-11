ARG BASE_IMAGE=node:24-bookworm
FROM ${BASE_IMAGE}

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.33.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY packages ./packages
COPY services/runtime-agent-ts ./services/runtime-agent-ts

WORKDIR /workspace
RUN pnpm install --frozen-lockfile --filter @kuuna/runtime-agent-ts... --prod=false
RUN pnpm --filter @kuuna/runtime-agent-ts... build

ENV NODE_ENV=production
EXPOSE 8100

WORKDIR /workspace/services/runtime-agent-ts
CMD ["pnpm", "start"]
