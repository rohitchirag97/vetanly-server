export interface User {
  id: string;
  fname: string;
  lname: string;
  phone: string;
  email?: string | null;
  phoneVerified?: boolean;
  emailVerified?: boolean;
  isPlatformAdmin?: boolean;
}

export type CreateUserInput = Omit<User, "id">;

export type UpdateUserInput = Partial<Omit<User, "id">>;
