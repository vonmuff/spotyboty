defmodule RoomsElixirTest do
  use ExUnit.Case

  alias RoomsElixir.{RoomServer, TelegramAuth}

  test "TelegramAuth verifies valid HMAC-SHA256 initData and rejects tampered data" do
    bot_token = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
    user_json = Jason.encode!(%{"id" => 42, "first_name" => "Alex", "username" => "alex_dev"})
    params = [{"auth_date", "1700000000"}, {"user", user_json}]
    data_check_string = Enum.map_join(params, "\n", fn {k, v} -> "#{k}=#{v}" end)
    secret_key = :crypto.mac(:hmac, :sha256, "WebAppData", bot_token)
    hash = :crypto.mac(:hmac, :sha256, secret_key, data_check_string) |> Base.encode16(case: :lower)

    init_data = URI.encode_query(params ++ [{"hash", hash}])
    assert {:ok, %{user_id: 42, name: "Alex", username: "alex_dev"}} = TelegramAuth.verify(init_data, bot_token)
    assert {:error, :invalid_signature} = TelegramAuth.verify(init_data <> "x", bot_token)
  end

  test "RoomServer syncs track, playback, permissions, and host transfer" do
    room_id = "test_room_#{System.unique_integer([:positive])}"
    {:ok, _pid} = RoomServer.ensure_started(room_id, 101)

    track = %{
      "file_id" => "AwACAgIAAxkBAA",
      "title" => "Nightcall",
      "performer" => "Kavinsky",
      "stream_url" => "/api/stream?id=1&exp=9999999999&sig=abc",
      "cover_url" => "/api/cover?id=1&exp=9999999999&sig=abc"
    }

    assert {:ok, state} = RoomServer.sync_track(room_id, 101, track, true)
    assert state.track.title == "Nightcall"
    assert state.is_playing == true

    # Guest cannot control in "host" mode
    assert {:error, :forbidden} = RoomServer.sync_playback(room_id, 202, false, 12.5)

    # Host switches mode to "all"
    assert {:ok, state2} = RoomServer.set_control_mode(room_id, 101, "all")
    assert state2.control_mode == "all"

    # Now guest can pause/seek
    assert {:ok, state3} = RoomServer.sync_playback(room_id, 202, false, 15.25)
    assert state3.is_playing == false
    assert state3.position_sec == 15.25

    # Rejects arbitrary external URLs
    bad_track = Map.put(track, "stream_url", "https://evil.example/a.mp3")
    assert {:error, :invalid_media_url} = RoomServer.sync_track(room_id, 101, bad_track, true)
  end
end
