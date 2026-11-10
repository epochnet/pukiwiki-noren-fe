# pukiwiki-noren-fe: BFF (Node 24+, runs TypeScript directly) + built web UI
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/bff/package.json apps/bff/
COPY apps/web/package.json apps/web/
COPY packages/syntax/package.json packages/syntax/
RUN npm ci
COPY packages packages
COPY apps apps
RUN npm run build -w apps/web

FROM node:24-bookworm-slim
WORKDIR /app
# 0.0.0.0 inside the container only; publish the port on the host's 127.0.0.1 (compose.yml)
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data NOREN_IN_CONTAINER=1
COPY package.json package-lock.json ./
COPY apps/bff/package.json apps/bff/
COPY apps/web/package.json apps/web/
COPY packages/syntax/package.json packages/syntax/
RUN npm ci --omit=dev -w apps/bff --include-workspace-root=false && npm cache clean --force
COPY packages packages
COPY apps/bff apps/bff
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/bff/src/main.ts"]
