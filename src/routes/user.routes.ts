import { Hono } from "hono";

import { authenticate } from "@/middleware/authenticate.middleware";
import { linkGoogle, sendLinkPhoneOtp, updateMe, verifyLinkPhoneOtp } from "@/controller/user.controller";

const userRoutes:Hono = new Hono();


userRoutes.patch("/", authenticate, updateMe);
userRoutes.post("/phone/send-otp", authenticate, sendLinkPhoneOtp);
userRoutes.post("/phone/verify", authenticate, verifyLinkPhoneOtp);
userRoutes.post("/google", authenticate, linkGoogle);

export default userRoutes;
