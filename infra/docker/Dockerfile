# One image per app. APP is one of: api | worker | web | database
#   docker build -f infra/docker/Dockerfile --build-arg APP=api      -t humantech-api .
#   docker build -f infra/docker/Dockerfile --build-arg APP=worker   -t humantech-worker .
#   docker build -f infra/docker/Dockerfile --build-arg APP=web      -t humantech-web .
#   docker build -f infra/docker/Dockerfile --build-arg APP=database -t humantech-database .   # migrations + operator CLI
# The database image runs `migrate` by default; pass another command to use the operator CLI, e.g.
#   docker run --env-file .env humantech-database node dist/cli.js activate-payroll acme --operator you@humantech.example
FROM node:22-slim AS build
ARG APP
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@humantech/${APP}..." build \
 && pnpm --filter "@humantech/${APP}" --prod deploy --legacy /out

FROM node:22-slim
ARG APP
ENV NODE_ENV=production APP=${APP}
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 3000 4000
CMD ["sh", "-c", "case \"$APP\" in web) exec node_modules/.bin/next start -p 3000;; database) exec node dist/cli.js migrate;; *) exec node dist/main.js;; esac"]
