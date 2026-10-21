# Image for CIs without a native integration:
#   docker run --rm -e AICD_LLM_API_KEY -v "$PWD:/repo" ghcr.io/aicd-dev/aicd analyze --ci local --log job.log
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm build \
    && pnpm --filter @aicd/cli deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production
# git: release notes, risk history, test selection. The repository is mounted with another owner: trust it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'
COPY --from=build /out /opt/aicd
WORKDIR /repo
USER node
ENTRYPOINT ["node", "/opt/aicd/dist/bin.js"]
CMD ["--help"]
