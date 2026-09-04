import express, { Router, Request, Response, NextFunction } from "express";

export interface CustomError extends Error {
  statusCode?: number;
  details?: unknown;
}

export const errorHandler = (
  err: CustomError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (res.headersSent) {
    return next(err);
  }

  const statusCode = (err as any).status || err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  // Handle JSON syntax error from express.json() parser
  if (err instanceof SyntaxError && "body" in err) {
    message = "Invalid JSON payload in request body.";
  }

  console.error(`[Error] ${req.method} ${req.path} -> ${message}`, err.details || "");

  res.setHeader("Content-Type", "application/json");
  res.status(statusCode).json({
    success: false,
    message,
    error: {
      message,
      statusCode,
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack, details: err.details }),
    },
  });
};
