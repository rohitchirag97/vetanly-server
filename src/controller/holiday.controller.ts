import {
  createHoliday,
  deleteHoliday,
  listHolidays,
  updateHoliday,
} from "@/services/holiday.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import {
  createHolidaySchema,
  listHolidaysQuerySchema,
  updateHolidaySchema,
} from "@/validator/holiday.validator";

export const listHolidaysController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listHolidaysQuerySchema, async (query) =>
    respond(c, await listHolidays(organizationId, userId, query), "Holidays fetched"),
  ),
);

export const createHolidayController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, createHolidaySchema, async (body) =>
    respond(c, await createHoliday(organizationId, userId, body), "Holiday created", 201),
  ),
);

export const updateHolidayController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "holidayId", (id) =>
    withBody(c, updateHolidaySchema, async (body) =>
      respond(c, await updateHoliday(organizationId, userId, id, body), "Holiday updated"),
    ),
  ),
);

export const deleteHolidayController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "holidayId", async (id) =>
    respond(c, await deleteHoliday(organizationId, userId, id), "Holiday deleted"),
  ),
);
