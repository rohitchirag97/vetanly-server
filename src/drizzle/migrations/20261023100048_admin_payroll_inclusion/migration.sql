-- Admins now count as employees only when include_in_payroll is set. Everyone already in an organization
-- (except the owner, whose choice is their own) keeps counting, so nobody drops out of lists or payroll.
UPDATE "user_organizations" SET "include_in_payroll" = true WHERE "role" <> 'super_admin';
