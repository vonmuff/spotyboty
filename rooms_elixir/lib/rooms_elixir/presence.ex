defmodule RoomsElixir.Presence do
  use Phoenix.Presence,
    otp_app: :rooms_elixir,
    pubsub_server: RoomsElixir.PubSub
end
