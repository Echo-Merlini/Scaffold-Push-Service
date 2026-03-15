import "dotenv/config";
import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { initWebPush } from "./push.js";
import { router } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

initWebPush();

const app = express();
app.use(express.json());

// Allow cross-origin requests from your web projects
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, x-admin-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

app.use(express.static(join(__dirname, "../public")));
app.use("/", router);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Push service running on port ${port}`);
});
