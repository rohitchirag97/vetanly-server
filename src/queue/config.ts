import { redisConnection } from "@/utils/env";

export const queueNames = {
  otp: "otpQueue",
  attendance: "attendanceQueue",
  whatsapp: "whatsappQueue",
  email: "emailQueue",
} as const;

/** Return connection options per BullMQ instance. */
export const getQueueConnection = () => ({ ...redisConnection });
