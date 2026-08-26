import { Router } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import filesRouter from "./files.js";
import foldersRouter from "./folders.js";
import storageRouter from "./storage.js";
import sharesRouter from "./shares.js";
import supabaseRouter from "./supabase.js";
import adminRouter from "./admin.js";
import publicAddonsRouter from "./publicAddons.js";

const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/supabase", supabaseRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/files", filesRouter);
apiRouter.use("/folders", foldersRouter);
apiRouter.use("/storage", storageRouter);
apiRouter.use("/shares", sharesRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/", publicAddonsRouter);

export default apiRouter;

