defmodule RoomsElixir.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Phoenix.PubSub, name: RoomsElixir.PubSub},
      RoomsElixir.Presence,
      {Registry, keys: :unique, name: RoomsElixir.RoomRegistry},
      {DynamicSupervisor, strategy: :one_for_one, name: RoomsElixir.RoomSupervisor},
      RoomsElixirWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: RoomsElixir.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
