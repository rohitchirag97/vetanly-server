import { Hono } from "hono";
import {
  getLoggedInUserController,
  googleLogin,
  logout,
  refreshAccessToken,
  sendotp,
  verifyotp
} from "@/controller/auth.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const authRoutes: Hono = new Hono();

authRoutes.post("/send-otp", sendotp);
authRoutes.post("/verify-otp", verifyotp);
authRoutes.post("/google", googleLogin);
authRoutes.post("/refresh", refreshAccessToken);
authRoutes.post("/logout", authenticate, logout);

authRoutes.get("/me", authenticate, getLoggedInUserController);

export default authRoutes;