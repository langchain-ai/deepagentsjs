FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy workspace root manifests (needed to resolve workspace deps)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY libs/ ./libs/
COPY examples/agent-protocol-server/ ./examples/agent-protocol-server/

# Install dependencies
RUN pnpm install --no-frozen-lockfile

WORKDIR /app/examples/agent-protocol-server

EXPOSE 2024

CMD ["npx", "tsx", "server.ts"]
