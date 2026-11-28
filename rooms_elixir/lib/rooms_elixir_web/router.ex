defmodule RoomsElixirWeb.Router do
  use Plug.Router

  plug :match
  plug :dispatch

  get "/health" do
    body =
      Jason.encode!(%{
        status: "ok",
        service: "rooms_elixir",
        active_rooms: RoomsElixir.RoomServer.active_room_count()
      })

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, body)
  end

  match _ do
    send_resp(conn, 404, "Not found")
  end
end
