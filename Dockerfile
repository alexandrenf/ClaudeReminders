# syntax = docker/dockerfile:1

ARG NODE_VERSION=22.14.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

WORKDIR /app

ENV NODE_ENV="production"

# Throw-away build stage to reduce size of final image
FROM base AS build

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Final stage for app image
FROM base

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/reminder.js .

EXPOSE 8080
CMD [ "node", "reminder.js" ]