defmodule RoomsElixirWeb.UserSocket do
  use Phoenix.Socket

  channel "room:*", RoomsElixirWeb.RoomChannel

  @impl true
  def connect(params, socket, _connect_info) do
    bot_token = Application.get_env(:rooms_elixir, :bot_token, "")
    allow_dev = Application.get_env(:rooms_elixir, :allow_dev_auth, false)
    init_data = Map.get(params, "init_data", "")

    case RoomsElixir.TelegramAuth.verify(init_data, bot_token) do
      {:ok, user} ->
        {:ok, assign(socket, :user, user)}

      {:error, _reason} when allow_dev ->
        dev_id =
          case Integer.parse(to_string(Map.get(params, "dev_user_id", ""))) do
            {id, ""} when id > 0 -> id
            _ -> :erlang.phash2(self(), 100_000) + 1
          end

        dev_name =
          params
          |> Map.get("dev_name", "Dev #{dev_id}")
          |> to_string()
          |> String.slice(0, 32)

        {:ok, assign(socket, :user, %{user_id: dev_id, name: dev_name, username: ""})}

      {:error, _reason} ->
        :error
    end
  end

  @impl true
  def id(socket), do: "user_socket:#{socket.assigns.user.user_id}"
end
