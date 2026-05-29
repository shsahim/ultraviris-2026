// Runs once when the server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { warmCache } = await import("@/lib/warm");
  await warmCache();
}
