import express from "express";

export const app = express();
app.use(express.json({ limit: "64kb" }));

// Phase 0 skeleton: liveness only. Auth/credits arrive in Phases 2-4.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "user-platform-api", phase: 0 });
});

// JSON 404 (no HTML leaks, no stack traces).
app.use((_req, res) => {
  res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
});

app.use(
  (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    void _next;
    res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
  },
);

export default app;
