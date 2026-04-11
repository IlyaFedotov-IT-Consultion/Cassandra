import { createWebServer, getWebRuntimeConfig } from "./server.js";

const config = getWebRuntimeConfig(process.env);
const server = createWebServer(process.env);

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Cassandra web console listening on http://0.0.0.0:${config.port}`);
});
