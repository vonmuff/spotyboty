defmodule RoomsElixir.TelegramAuth do
  @moduledoc """
  Cryptographic verification of Telegram WebApp `initData` (HMAC-SHA256).
  Matches Telegram Bot API specification and aiogram's `safe_parse_webapp_init_data`.
  """

  @spec verify(String.t(), String.t()) :: {:ok, map()} | {:error, atom()}
  def verify(init_data, bot_token)
      when is_binary(init_data) and is_binary(bot_token) and byte_size(init_data) > 0 and
             byte_size(bot_token) > 0 do
    params = URI.decode_query(init_data)

    case Map.pop(params, "hash") do
      {nil, _} ->
        {:error, :missing_hash}

      {received_hash, rest} ->
        data_check_string =
          rest
          |> Enum.sort_by(fn {k, _} -> k end)
          |> Enum.map_join("\n", fn {k, v} -> "#{k}=#{v}" end)

        secret_key = :crypto.mac(:hmac, :sha256, "WebAppData", bot_token)

        expected_hash =
          :crypto.mac(:hmac, :sha256, secret_key, data_check_string)
          |> Base.encode16(case: :lower)

        if Plug.Crypto.secure_compare(String.downcase(received_hash), expected_hash) do
          extract_user(rest)
        else
          {:error, :invalid_signature}
        end
    end
  end

  def verify(_, _), do: {:error, :invalid_input}

  defp extract_user(%{"user" => user_json}) when is_binary(user_json) do
    case Jason.decode(user_json) do
      {:ok, %{"id" => id} = user} when is_integer(id) ->
        first = Map.get(user, "first_name") || ""
        last = Map.get(user, "last_name") || ""
        username = Map.get(user, "username") || ""

        display_name =
          [first, last]
          |> Enum.map(&String.trim/1)
          |> Enum.reject(&(&1 == ""))
          |> Enum.join(" ")
          |> case do
            "" when username != "" -> "@" <> username
            "" -> "Слушатель"
            name -> name
          end

        {:ok,
         %{
           user_id: id,
           name: String.slice(display_name, 0, 32),
           username: username
         }}

      _ ->
        {:error, :invalid_user_json}
    end
  end

  defp extract_user(_), do: {:error, :missing_user}
end
