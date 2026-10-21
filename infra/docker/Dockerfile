# Build:  docker build -f infra/docker/Dockerfile --build-arg APP=api -t humantech-api .
#         docker build -f infra/docker/Dockerfile --build-arg APP=worker -t humantech-worker .
FROM node:22-slim AS build
ARG APP
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@humantech/${APP}..." build \
 && pnpm --filter "@humantech/${APP}" --prod deploy /out

FROM node:22-slim
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["node", "dist/main.js"]
