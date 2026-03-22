import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getProjectByApiKey } from "../storage.js";

export const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_KEY || "changeme";

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

// Admin-only routes — accepts a JWT (issued by /auth/login) or the raw ADMIN_KEY env var
export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-admin-key"] as string | undefined;
  if (!key) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Try JWT first
  try {
    const payload = jwt.verify(key, JWT_SECRET);
    (req as any).user = payload;
    return next();
  } catch {}

  // Fallback: raw ADMIN_KEY env var (backward compat for scripts / CLI usage)
  if (process.env.ADMIN_KEY && key === process.env.ADMIN_KEY) {
    return next();
  }

  res.status(401).json({ error: "Unauthorized" });
}
