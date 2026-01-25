// /var/www/scrapbot/src/index.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import morgan from "morgan";

import internalRoutes from "./routes/internal.js";
import authRoutes from "./routes/auth.js";
import debugRoutes from "./routes/debug.js";
import channelsRoutes from "./routes/channels.js";
import botKickAuthRoutes from "./routes/botKickAuth.js";
import inboundKickRoutes from "./routes/inboundKick.js";

import moderationApi from "./routes/moderationApi.js";
import intelApi from "./routes/intelApi.js";
import metricsRoutes from "./routes/metrics.js";
import statusRoutes from "./routes/status.js";

import kickNarrationRoutes from "./routes/kickNarration.js";

import { loadAllCommands } from "./commandStore.js";
import { loadAllModerationRules } from "./moderationStore.js";
import { connectAllKnownChannels } from "./lib/wsSupervisor.js";

// 🔥 Orchestration
import { startRaffleOrchestrator } from "./workers/raffleOrchestrator.js";
import { startModProbeScheduler } from "./workers/modProbeScheduler.js";
import './workers/refresh.js';



// -----------------------------
// HARD FAIL VISIBILITY
// -----------------------------
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException", err);
});

// -----------------------------
// ENV FIRST
// -----------------------------
dotenv.config({ path: "/var/www/scrapbot/.env" });

console.log("[boot] Scrapbot starting");
console.log("[boot] env", {
  PORT: process.env.PORT,
  RAFFLE_ORCHESTRATOR_ENABLED: process.env.RAFFLE_ORCHESTRATOR_ENABLED,
  has_SCRAPBOT_EVENT_TOKEN: !!process.env.SCRAPBOT_EVENT_TOKEN,
  has_SCRAPBOT_NARRATION_TOKEN: !!process.env.SCRAPBOT_NARRATION_TOKEN,
});

// -----------------------------
// START ORCHESTRATION *BEFORE* HTTP
// -----------------------------
let raffleOrch = null;
let modProbe = null;
let refreshWorker = null;

try {
  console.log("[boot] starting raffle orchestrator");
  raffleOrch = startRaffleOrchestrator();
  console.log("[boot] raffle orchestrator running");
} catch (err) {
  console.error("[boot] raffle orchestrator FAILED", err);
}

// -----------------------------
// HTTP APP
// -----------------------------
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(cors());
app.use(morgan("dev"));

// -----------------------------
// ROUTES
// -----------------------------
app.use("/api/channels", channelsRoutes);
app.use("/api/status", statusRoutes);
app.use(metricsRoutes);

app.use(inboundKickRoutes);
app.use(moderationApi);
app.use(intelApi);

// ✅ Narration (Dashboard → Scrapbot → Kick chat)
app.use(kickNarrationRoutes);

// Health check

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "scrapbot",
    orchestration: {
      raffle: raffleOrch ? "running" : "not_running",
      mod_probe: modProbe ? "running" : "not_running",
      token_refresh: "module_loaded", // side-effect worker
    },
    time: new Date().toISOString(),
  });
});



app.use(authRoutes);
app.use(botKickAuthRoutes);
app.use(debugRoutes);
app.use("/api/internal", internalRoutes);

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not Found" });
});

// -----------------------------
// BOOT SERVICES
// -----------------------------
await Promise.allSettled([loadAllCommands(), loadAllModerationRules()]);

const PORT = Number(process.env.PORT || 3030);
app.listen(PORT, "127.0.0.1", async () => {
  console.log(`🚀 Scrapbot listening on 127.0.0.1:${PORT}`);
  await connectAllKnownChannels();
  console.log("[chat] channels connected");

  // 🔎 Periodic moderation probe (keeps mod_status fresh for the Dashboard panel)
  try {
    modProbe = startModProbeScheduler();
  } catch (e) {
    console.error("[boot] mod probe scheduler FAILED", e);
  }

});
