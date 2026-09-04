import dotenv from "dotenv";
dotenv.config({ override: true });
import { app } from "../server/app.js";

// Export the Express app as the Vercel serverless function handler
export default app;
