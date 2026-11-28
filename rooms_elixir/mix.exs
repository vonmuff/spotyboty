defmodule RoomsElixir.MixProject do
  use Mix.Project

  def project do
    [
      app: :rooms_elixir,
      version: "0.1.0",
      elixir: "~> 1.16",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      mod: {RoomsElixir.Application, []},
      extra_applications: [:logger, :crypto, :runtime_tools]
    ]
  end

  defp deps do
    [
      {:phoenix, "~> 1.7.14"},
      {:bandit, "~> 1.6"},
      {:jason, "~> 1.4"}
    ]
  end
end
