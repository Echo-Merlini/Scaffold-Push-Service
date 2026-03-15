import type { Request, Response, NextFunction } from "express";
import { getProjectByApiKey } from "../storage.js";

// Attach project to request if valid API key provided
export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"] as string | undefined;
  if (!key) {
    res.status(401).json({ error: "Missing x-api-key header" });
    return;
  }

  const project = await getProjectByApiKey(key);
  if (!project) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  (req as any).project = project;
  next();
}

// Admin-only routes (project management)
export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-admin-key"] as string | undefined;
  if (!key || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: "Invalid admin key" });
    return;
  }
  next();
}
