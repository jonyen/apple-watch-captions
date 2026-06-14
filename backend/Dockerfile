# Production image for the Watch Captions STT relay.
# Runs via tsx (TypeScript at runtime) — see README "Runtime note".
FROM node:20-slim

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

# AUTH_TOKEN and DEEPGRAM_API_KEY are provided at runtime (fly secrets / -e).
CMD ["npm", "start"]
