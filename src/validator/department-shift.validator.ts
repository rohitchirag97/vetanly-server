import { z } from "zod";

const nonEmpty = (value: object) => Object.keys(value).length > 0;
const NOTHING_TO_UPDATE = "Provide at least one field to update";

const timeOfDay = z
  .string()
  .regex(
    /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
    "Time must be in HH:MM or HH:MM:SS format",
  );

const name = z.string().trim().min(1, "Name is required").max(100);
const optionalText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();

export const createDepartmentSchema = z.object({
  name,
  code: optionalText(32),
  description: optionalText(500),
});

export const updateDepartmentSchema = z
  .object({
    name: name.optional(),
    code: optionalText(32),
    description: optionalText(500),
    isActive: z.boolean().optional(),
  })
  .refine(nonEmpty, NOTHING_TO_UPDATE);

const shiftFields = {
  name,
  startTime: timeOfDay,
  endTime: timeOfDay,
  breakMinutes: z.number().int().min(0).max(600),
  gracePeriodMinutes: z.number().int().min(0).max(240),
};

export const createShiftSchema = z
  .object({
    ...shiftFields,
    breakMinutes: shiftFields.breakMinutes.default(0),
    gracePeriodMinutes: shiftFields.gracePeriodMinutes.default(0),
  })
  .refine((shift) => shift.startTime !== shift.endTime, {
    message: "Start and end time must be different",
  });

export const updateShiftSchema = z
  .object({
    name: name.optional(),
    startTime: timeOfDay.optional(),
    endTime: timeOfDay.optional(),
    breakMinutes: shiftFields.breakMinutes.optional(),
    gracePeriodMinutes: shiftFields.gracePeriodMinutes.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(nonEmpty, NOTHING_TO_UPDATE);
