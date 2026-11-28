defmodule RoomsElixir.RoomServer do
  @moduledoc """
  One isolated GenServer per listening room.
  Holds authoritative playback state (track, play/pause, position, host, control_mode)
  and automatically shuts down after 5 minutes of being empty.
  """
  use GenServer, restart: :temporary

  @idle_timeout_ms 5 * 60 * 1000

  defstruct [
    :room_id,
    :host_id,
    control_mode: "host",
    track: nil,
    is_playing: false,
    position_sec: 0.0,
    updated_at_ms: 0,
    idle_timer: nil
  ]

  # ===== Public API =====

  def via(room_id), do: {:via, Registry, {RoomsElixir.RoomRegistry, room_id}}

  def ensure_started(room_id, creator_user_id) do
    case Registry.lookup(RoomsElixir.RoomRegistry, room_id) do
      [{pid, _}] ->
        {:ok, pid}

      [] ->
        spec = {__MODULE__, {room_id, creator_user_id}}

        case DynamicSupervisor.start_child(RoomsElixir.RoomSupervisor, spec) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
          err -> err
        end
    end
  end

  def active_room_count do
    DynamicSupervisor.count_children(RoomsElixir.RoomSupervisor).active
  end

  def get_state(room_id) do
    GenServer.call(via(room_id), :get_state)
  end

  def sync_track(room_id, user_id, track_params, is_playing) do
    GenServer.call(via(room_id), {:sync_track, user_id, track_params, is_playing})
  end

  def sync_playback(room_id, user_id, is_playing, position_sec) do
    GenServer.call(via(room_id), {:sync_playback, user_id, is_playing, position_sec})
  end

  def set_control_mode(room_id, user_id, mode) do
    GenServer.call(via(room_id), {:set_control_mode, user_id, mode})
  end

  def member_joined(room_id, user_id) do
    GenServer.cast(via(room_id), {:member_joined, user_id})
  end

  def member_left(room_id, user_id, remaining_user_ids) do
    GenServer.cast(via(room_id), {:member_left, user_id, remaining_user_ids})
  end

  # ===== GenServer callbacks =====

  def start_link({room_id, creator_user_id}) do
    GenServer.start_link(__MODULE__, {room_id, creator_user_id}, name: via(room_id))
  end

  @impl true
  def init({room_id, creator_user_id}) do
    state = %__MODULE__{
      room_id: room_id,
      host_id: creator_user_id,
      updated_at_ms: now_ms()
    }

    {:ok, state}
  end

  @impl true
  def handle_call(:get_state, _from, state) do
    {:reply, serialize(state), state}
  end

  @impl true
  def handle_call({:sync_track, user_id, track_params, is_playing}, _from, state) do
    if can_control?(state, user_id) do
      case sanitize_track(track_params) do
        {:ok, track} ->
          next_state = %{
            state
            | track: track,
              is_playing: is_playing == true,
              position_sec: 0.0,
              updated_at_ms: now_ms()
          }

          {:reply, {:ok, serialize(next_state)}, next_state}

        {:error, reason} ->
          {:reply, {:error, reason}, state}
      end
    else
      {:reply, {:error, :forbidden}, state}
    end
  end

  @impl true
  def handle_call({:sync_playback, user_id, is_playing, position_sec}, _from, state) do
    if can_control?(state, user_id) do
      pos = sanitize_position(position_sec)

      next_state = %{
        state
        | is_playing: is_playing == true,
          position_sec: pos,
          updated_at_ms: now_ms()
      }

      {:reply, {:ok, serialize(next_state)}, next_state}
    else
      {:reply, {:error, :forbidden}, state}
    end
  end

  @impl true
  def handle_call({:set_control_mode, user_id, mode}, _from, state) do
    cond do
      state.host_id != user_id ->
        {:reply, {:error, :forbidden}, state}

      mode not in ["host", "all"] ->
        {:reply, {:error, :invalid_mode}, state}

      true ->
        next_state = %{state | control_mode: mode}
        {:reply, {:ok, serialize(next_state)}, next_state}
    end
  end

  @impl true
  def handle_cast({:member_joined, user_id}, state) do
    state = cancel_idle_timer(state)
    state = if is_nil(state.host_id), do: %{state | host_id: user_id}, else: state
    {:noreply, state}
  end

  @impl true
  def handle_cast({:member_left, user_id, remaining_user_ids}, state) do
    cond do
      remaining_user_ids == [] ->
        # Pause playback and schedule idle cleanup when nobody is left
        cur_pos = live_position(state, now_ms())
        timer = Process.send_after(self(), :idle_shutdown, @idle_timeout_ms)

        next_state = %{
          cancel_idle_timer(state)
          | is_playing: false,
            position_sec: cur_pos,
            updated_at_ms: now_ms(),
            idle_timer: timer
        }

        {:noreply, next_state}

      state.host_id == user_id ->
        new_host = hd(remaining_user_ids)
        next_state = %{state | host_id: new_host}

        Phoenix.PubSub.broadcast(
          RoomsElixir.PubSub,
          "room:" <> state.room_id,
          {:room_state_updated, serialize(next_state)}
        )

        {:noreply, next_state}

      true ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info(:idle_shutdown, state) do
    {:stop, :normal, state}
  end

  # ===== Helpers =====

  defp can_control?(%__MODULE__{control_mode: "all"}, _user_id), do: true
  defp can_control?(%__MODULE__{host_id: host_id}, user_id), do: host_id == user_id

  defp cancel_idle_timer(%__MODULE__{idle_timer: nil} = state), do: state

  defp cancel_idle_timer(%__MODULE__{idle_timer: ref} = state) do
    Process.cancel_timer(ref)
    %{state | idle_timer: nil}
  end

  defp now_ms, do: System.system_time(:millisecond)

  defp live_position(%__MODULE__{is_playing: true, position_sec: pos, updated_at_ms: ts}, now) do
    delta = max(0, now - ts) / 1000.0
    Float.round(pos + delta, 3)
  end

  defp live_position(%__MODULE__{position_sec: pos}, _now), do: Float.round(pos * 1.0, 3)

  defp serialize(state) do
    now = now_ms()

    %{
      room_id: state.room_id,
      host_id: state.host_id,
      control_mode: state.control_mode,
      track: state.track,
      is_playing: state.is_playing,
      position_sec: live_position(state, now),
      server_time_ms: now
    }
  end

  defp sanitize_position(val) when is_number(val) and val >= 0 and val < 86_400 do
    Float.round(val * 1.0, 3)
  end

  defp sanitize_position(_), do: 0.0

  defp sanitize_track(%{
         "file_id" => file_id,
         "title" => title,
         "performer" => performer,
         "stream_url" => stream_url
       } = raw)
       when is_binary(file_id) and is_binary(stream_url) do
    cover_url = Map.get(raw, "cover_url", "")

    if String.starts_with?(stream_url, "/api/stream?") and
         (cover_url == "" or String.starts_with?(cover_url, "/api/cover?")) do
      {:ok,
       %{
         file_id: String.slice(file_id, 0, 200),
         title: String.slice(to_string(title || "Без названия"), 0, 140),
         performer: String.slice(to_string(performer || ""), 0, 120),
         stream_url: String.slice(stream_url, 0, 512),
         cover_url: String.slice(to_string(cover_url), 0, 512)
       }}
    else
      {:error, :invalid_media_url}
    end
  end

  defp sanitize_track(_), do: {:error, :invalid_track}
end
