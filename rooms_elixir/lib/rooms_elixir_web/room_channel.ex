defmodule RoomsElixirWeb.RoomChannel do
  use Phoenix.Channel

  alias RoomsElixir.{Presence, RoomServer}

  @room_id_regex ~r/^[a-zA-Z0-9_-]{4,24}$/

  @impl true
  def join("room:" <> room_id, _params, socket) do
    if Regex.match?(@room_id_regex, room_id) do
      user = socket.assigns.user
      {:ok, _pid} = RoomServer.ensure_started(room_id, user.user_id)
      RoomServer.member_joined(room_id, user.user_id)
      state = RoomServer.get_state(room_id)

      socket = assign(socket, :room_id, room_id)
      send(self(), :after_join)

      {:ok,
       %{
         state: state,
         you: %{
           user_id: user.user_id,
           name: user.name,
           is_host: state.host_id == user.user_id
         }
       }, socket}
    else
      {:error, %{reason: "invalid_room_id"}}
    end
  end

  @impl true
  def handle_info(:after_join, socket) do
    user = socket.assigns.user

    {:ok, _} =
      Presence.track(socket, Integer.to_string(user.user_id), %{
        user_id: user.user_id,
        name: user.name,
        username: user.username,
        joined_at: System.system_time(:millisecond)
      })

    push(socket, "presence_state", Presence.list(socket))
    {:noreply, socket}
  end

  @impl true
  def handle_info({:room_state_updated, state}, socket) do
    push(socket, "room_state", state)
    {:noreply, socket}
  end

  @impl true
  def handle_in("ping", %{"client_time_ms" => client_ts}, socket) do
    {:reply, {:ok, %{client_time_ms: client_ts, server_time_ms: System.system_time(:millisecond)}}, socket}
  end

  @impl true
  def handle_in("ping", _params, socket) do
    {:reply, {:ok, %{server_time_ms: System.system_time(:millisecond)}}, socket}
  end

  @impl true
  def handle_in("request_state", _params, socket) do
    state = RoomServer.get_state(socket.assigns.room_id)
    {:reply, {:ok, state}, socket}
  end

  @impl true
  def handle_in("sync_track", %{"track" => track} = params, socket) do
    user_id = socket.assigns.user.user_id
    room_id = socket.assigns.room_id
    is_playing = Map.get(params, "is_playing", true)

    case RoomServer.sync_track(room_id, user_id, track, is_playing) do
      {:ok, state} ->
        broadcast!(socket, "room_state", Map.put(state, :actor_id, user_id))
        {:reply, {:ok, state}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  @impl true
  def handle_in("sync_playback", params, socket) do
    user_id = socket.assigns.user.user_id
    room_id = socket.assigns.room_id
    is_playing = Map.get(params, "is_playing", false)
    position_sec = Map.get(params, "position_sec", 0.0)

    case RoomServer.sync_playback(room_id, user_id, is_playing, position_sec) do
      {:ok, state} ->
        broadcast!(socket, "room_state", Map.put(state, :actor_id, user_id))
        {:reply, {:ok, state}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  @impl true
  def handle_in("set_control_mode", %{"mode" => mode}, socket) do
    user_id = socket.assigns.user.user_id
    room_id = socket.assigns.room_id

    case RoomServer.set_control_mode(room_id, user_id, mode) do
      {:ok, state} ->
        broadcast!(socket, "room_state", Map.put(state, :actor_id, user_id))
        {:reply, {:ok, state}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  @impl true
  def terminate(_reason, socket) do
    if room_id = socket.assigns[:room_id] do
      user_id = socket.assigns.user.user_id

      remaining =
        Presence.list("room:" <> room_id)
        |> Map.keys()
        |> Enum.map(&String.to_integer/1)
        |> Enum.reject(&(&1 == user_id))

      RoomServer.member_left(room_id, user_id, remaining)
    end

    :ok
  end
end
