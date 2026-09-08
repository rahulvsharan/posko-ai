import { Hono } from "hono";
import { listModels } from "../core/model-registry.js";

export const modelsRoute = new Hono();

modelsRoute.get("/", (c) => {
  const models = listModels();
  return c.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: m.upstream === "kilo" ? "kilocode" : "opencode",
    })),
  });
});
