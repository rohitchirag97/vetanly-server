-- Plan features become enforced keys (see services/plan-features.ts) instead of display labels.
-- A plan with nothing ticked gave everything before, so it keeps everything.
UPDATE "platform_plans"
SET "features" = '["attendance","overtime","leave","payroll","statutory","loans","expenses","settlements","bonus","accounting","documents","assets","reports"]'::jsonb
WHERE "features" = '[]'::jsonb;
--> statement-breakpoint
-- Old labels to keys. Leave, expenses and assets were never on the checklist and every plan had them;
-- the payroll add-ons also come along wherever payroll was ticked.
UPDATE "platform_plans" AS p
SET "features" = (
  SELECT COALESCE(jsonb_agg(DISTINCT k.key), '[]'::jsonb)
  FROM (
    SELECT CASE label
      WHEN 'Attendance' THEN 'attendance'
      WHEN 'Payroll' THEN 'payroll'
      WHEN 'Reports' THEN 'reports'
      WHEN 'Statutory' THEN 'statutory'
      WHEN 'Overtime' THEN 'overtime'
      WHEN 'Employee documents' THEN 'documents'
      ELSE NULL
    END AS key
    FROM jsonb_array_elements_text(p."features") AS label
    UNION ALL SELECT unnest(ARRAY['leave', 'expenses', 'assets'])
    UNION ALL SELECT unnest(ARRAY['loans', 'settlements', 'bonus', 'accounting'])
      WHERE p."features" ? 'Payroll' OR p."features" ? 'Statutory'
    -- What the ticked features need: statutory needs payroll, payroll and overtime need attendance.
    UNION ALL SELECT 'payroll' WHERE p."features" ? 'Statutory'
    UNION ALL SELECT 'attendance' WHERE p."features" ?| ARRAY['Payroll', 'Statutory', 'Overtime']
  ) AS k
  WHERE k.key IS NOT NULL
)
WHERE NOT ("features" ? 'attendance');
