# Production image for the Watch Captions STT relay.
# Runs via tsx (TypeScript at runtime) — see README "Runtime note".
# Node 24: the relay's identity database uses the built-in `node:sqlite`,
# which is unflagged from Node 23.4 onward. Staying on 20 would mean taking
# on `better-sqlite3` and the build toolchain a native module needs.
FROM node:24-slim

WORKDIR /app

# Install only runtime dependencies (ws, @deepgram/sdk, tsx).
# Dev deps (typescript, vitest, @types) are not needed to run.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App sources.
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# DEEPGRAM_API_KEY and ADMIN_TOKEN are provided at runtime (fly secrets / -e).
CMD ["npm", "start"]
