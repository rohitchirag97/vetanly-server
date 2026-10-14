import { Hono } from "hono";

import {
  createHolidayController,
  deleteHolidayController,
  listHolidaysController,
  updateHolidayController,
} from "@/controller/holiday.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const holidayRoutes: Hono = new Hono();

holidayRoutes.get("/", authenticate, listHolidaysController);
holidayRoutes.post("/", authenticate, createHolidayController);
holidayRoutes.patch("/:holidayId", authenticate, updateHolidayController);
holidayRoutes.delete("/:holidayId", authenticate, deleteHolidayController);

export default holidayRoutes;
