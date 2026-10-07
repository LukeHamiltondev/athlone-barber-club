import { config, loadShop } from "./src/config.js";
import { createApp } from "./src/app.js";

const { server } = createApp({ config, loadShop });
server.listen(config.port, () => {
  console.log(`Athlone Barber Club running on ${config.publicUrl} (port ${config.port})`);
  if (!config.adminPassword) console.warn("ADMIN_PASSWORD is not set, so the owner's diary at /admin is locked.");
  if (!process.env.ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY is not set, so the phone receptionist can't answer calls.");
});
