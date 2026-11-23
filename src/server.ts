import { startServer } from "./app.ts";

const { url, close } = await startServer();
console.log(`station-window api listening on ${url}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void close().then(() => process.exit(0));
  });
}
