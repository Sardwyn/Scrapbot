// src/routes/internal.js
import express from "express";
import { loadAllCommands } from "../commandStore.js";

const router = express.Router();

router.use(express.json());

const INTERNAL_SECRET = process.env.SCRAPBOT_SHARED_SECRET;


function requireInternal(req, res, next) {
  const header = req.get("x-internal-secret");
  if (!header || header !== INTERNAL_SECRET) {
    console.warn("[internal] bad or missing x-internal-secret");
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  next();
}

// ...

router.post("/reload-commands", requireInternal, async (req, res) => {
  console.log("[internal] /reload-commands hit", { body: req.body });

  const { account_id } = req.body ?? {};

  try {
    await loadAllCommands(); // brute-force reload is fine at your scale

    return res.json({
      ok: true,
      reloaded: "all",
      account_id: account_id ?? null,
    });
  } catch (err) {
    console.error("[internal] /reload-commands failed", err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

export default router;
