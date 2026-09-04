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
import { authLimiter, shareLimiter } from "../middleware/security.js";

const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/supabase", supabaseRouter);
apiRouter.use("/auth", authLimiter, authRouter);
apiRouter.all(
  [
    "/register",
    "/signup",
    "/login",
    "/signin",
    "/validate-signup",
    "/validate-register",
    "/verify-email-otp",
    "/resend-verification",
    "/verification-status",
    "/forgot-password",
  ],
  authLimiter,
  authRouter
);
apiRouter.use("/files", filesRouter);
apiRouter.use("/folders", foldersRouter);
apiRouter.use("/storage", shareLimiter, storageRouter);
apiRouter.use("/shares", shareLimiter, sharesRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/", publicAddonsRouter);

export default apiRouter;

