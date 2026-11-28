import Config

port =
  case System.get_env("ROOMS_PORT") || System.get_env("PORT") do
    nil -> 4000
    val -> String.to_integer(val)
  end

ip =
  case System.get_env("ROOMS_BIND_ALL") do
    "1" -> {0, 0, 0, 0}
    "true" -> {0, 0, 0, 0}
    _ -> {127, 0, 0, 1}
  end

secret_key_base =
  System.get_env("ROOMS_SECRET_KEY_BASE") ||
    :crypto.hash(:sha512, System.get_env("BOT_TOKEN") || "spotyboty-rooms-fallback-secret")
    |> Base.encode64()

config :rooms_elixir, RoomsElixirWeb.Endpoint,
  http: [ip: ip, port: port],
  secret_key_base: secret_key_base,
  server: config_env() != :test

config :rooms_elixir,
  bot_token: System.get_env("BOT_TOKEN") || "",
  allow_dev_auth: System.get_env("ROOMS_ALLOW_DEV_AUTH") in ["1", "true"]
