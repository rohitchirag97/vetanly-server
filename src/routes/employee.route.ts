import { Hono } from 'hono';

import {
  createEmployeeController,
  bulkCheckEmployeesController,
  bulkCreateEmployeesController,
  listEmployeesController,
  removeEmployeeController,
  updateEmployeeController,
  updateEmployeeStatusController,
} from '@/controller/employee.controller';
import {
  updatePayrollInclusionController,
  getEmploymentController,
  updateEmploymentController,
} from '@/controller/payroll.controller';
import { authenticate } from '@/middleware/authenticate.middleware';

const employeeRoutes: Hono = new Hono();

employeeRoutes.patch('/payroll-inclusion', authenticate, updatePayrollInclusionController);
employeeRoutes.get('/', authenticate, listEmployeesController);
employeeRoutes.post('/', authenticate, createEmployeeController);
employeeRoutes.post('/bulk/check', authenticate, bulkCheckEmployeesController);
employeeRoutes.post('/bulk', authenticate, bulkCreateEmployeesController);
employeeRoutes.patch('/:employeeId', authenticate, updateEmployeeController);
employeeRoutes.patch('/:employeeId/status', authenticate, updateEmployeeStatusController);
employeeRoutes.get('/:employeeId/employment', authenticate, getEmploymentController);
employeeRoutes.patch('/:employeeId/employment', authenticate, updateEmploymentController);
employeeRoutes.delete('/:employeeId', authenticate, removeEmployeeController);

export default employeeRoutes;
