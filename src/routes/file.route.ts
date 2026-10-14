import { Hono } from "hono";

import { readSignedLocalFile } from "@/utils/file-storage";

const fileRoutes: Hono = new Hono();

// No login needed: the link itself is signed and expires after a few minutes, like an R2 presigned URL.
fileRoutes.get("/download", async (c) => {
  const found = await readSignedLocalFile(c.req.query());
  if (!found) return c.json({ status: "error", message: "This link is invalid or has expired" }, 404);
  return new Response(found.file, {
    headers: {
      "Content-Type": found.contentType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export default fileRoutes;
