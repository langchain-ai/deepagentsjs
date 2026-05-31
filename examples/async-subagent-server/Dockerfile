# Build from the repo root:
#   docker build -f examples/async-subagent-server/Dockerfile -t async-subagent-server .
#
# Run:
#   docker run -p 2024:2024 \
#     -e ANTHROPIC_API_KEY=your-key \
#     -e TAVILY_API_KEY=your-key \
#     async-subagent-server

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies — only copy what's needed for the install step
# so Docker can cache this layer independently of source changes.
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY libs/deepagents/package.json ./libs/deepagents/
COPY examples/package.json ./examples/
RUN pnpm install --frozen-lockfile --shamefully-hoist

# Final image — copy only what the server needs at runtime.
FROM base AS runner
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY libs/deepagents/dist ./libs/deepagents/dist
COPY libs/deepagents/package.json ./libs/deepagents/package.json
COPY examples/package.json ./examples/package.json
COPY examples/async-subagent-server/ ./examples/async-subagent-server/

WORKDIR /app/examples/async-subagent-server

ENV PORT=2024
EXPOSE 2024

CMD ["/app/node_modules/.bin/tsx", "server.ts"]
