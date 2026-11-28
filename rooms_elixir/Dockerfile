FROM elixir:1.18-alpine AS build

RUN apk add --no-cache build-base

WORKDIR /app
ENV MIX_ENV=prod

RUN mix local.hex --force && mix local.rebar --force

COPY mix.exs mix.lock* ./
RUN mix deps.get --only prod && mix deps.compile

COPY config config
COPY lib lib
RUN mix compile && mix release

FROM alpine:3.21 AS runtime

RUN apk add --no-cache libstdc++ openssl ncurses-libs curl

WORKDIR /app
COPY --from=build /app/_build/prod/rel/rooms_elixir ./

ENV ROOMS_PORT=4000 \
    ROOMS_BIND_ALL=false \
    ERL_FLAGS="+S 2:2"

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:4000/health || exit 1

CMD ["/app/bin/rooms_elixir", "start"]
