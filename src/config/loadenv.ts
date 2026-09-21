// Load ./.env before any other module reads process.env. cli.ts imports this
// FIRST — ESM evaluates imports in order, so config (llm.ts) sees .env values.
try {
  process.loadEnvFile();
} catch {
  // No .env present: fall back to the real environment.
}
