defmodule RoomsElixirWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :rooms_elixir

  socket "/ws/rooms", RoomsElixirWeb.UserSocket,
    websocket: [
      timeout: 45_000,
      check_origin: false
    ],
    longpoll: false

  plug RoomsElixirWeb.Router
end
