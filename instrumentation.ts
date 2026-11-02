export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPlayersMonitor } = await import("./lib/server/players-monitor");
    startPlayersMonitor();
  }
}
