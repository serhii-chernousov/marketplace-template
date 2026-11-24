# syntax=docker/dockerfile:1

# The npm token is bound to a private scope only, so npm never sends it to the public registry.
# It is optional: a local `docker compose build` has no private registry to reach.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_token \
    touch /tmp/npmrc \
 && if [ -s /run/secrets/npm_token ]; then \
      printf '%s\n' '@marketplace-private:registry=https://npm.internal.example/' \
        "//npm.internal.example/:_authToken=$(cat /run/secrets/npm_token)" > /tmp/npmrc; \
    fi \
 && npm ci --userconfig /tmp/npmrc --no-audit --no-fund \
 && rm -f /tmp/npmrc

FROM deps AS build
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npx nest build

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_token \
    touch /tmp/npmrc \
 && if [ -s /run/secrets/npm_token ]; then \
      printf '%s\n' '@marketplace-private:registry=https://npm.internal.example/' \
        "//npm.internal.example/:_authToken=$(cat /run/secrets/npm_token)" > /tmp/npmrc; \
    fi \
 && npm ci --omit=dev --userconfig /tmp/npmrc --no-audit --no-fund \
 && rm -f /tmp/npmrc

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY openapi ./openapi
USER 65532:65532
EXPOSE 3000
CMD ["dist/main.js"]
