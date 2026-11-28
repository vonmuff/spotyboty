import Config

config :phoenix, :json_library, Jason

config :rooms_elixir, RoomsElixirWeb.Endpoint,
  adapter: Bandit.PhoenixAdapter,
  http: [ip: {127, 0, 0, 1}, port: 4000],
  pubsub_server: RoomsElixir.PubSub,
  secret_key_base: String.duplicate("spotyboty_rooms_dev_secret_", 3),
  check_origin: false,
  server: true

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  level: :info
