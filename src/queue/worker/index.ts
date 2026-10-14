import type { Worker } from "bullmq";
import { createAttendanceWorker } from "./attendanceWorker";
import { createOtpWorker } from "./otpWorker";
import { createWhatsAppWorker } from "./whatsappWorker";
import { createEmailWorker } from "./emailWorker";

// Register each service worker here as the background services grow.
const workers: Worker[] = [createOtpWorker(), createAttendanceWorker(), createWhatsAppWorker(), createEmailWorker()];

for (const worker of workers) {
  worker.on("error", (error) => {
    console.error(`Worker ${worker.name} connection error:`, error);
  });

  worker.on("failed", (job, error) => {
    console.error(
      `Worker ${worker.name} failed job ${job?.id ?? "unknown"}:`,
      error,
    );
  });

  worker.on("completed", (job) => {
    console.info(`Worker ${worker.name} completed job ${job.id}`);
  });
}

console.info(`Started ${workers.length} background worker(s)`);

export async function closeWorkers() {
  await Promise.all(workers.map((worker) => worker.close()));
}
