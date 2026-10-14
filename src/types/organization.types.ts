export interface Organization {
  id: string;
  name: string;
  slug: string;
  status?: "active" | "suspended" | "pending_deletion";
}

export interface UserOrganization {
  id: string;
  userId: string;
    organizationId: string;
}

export interface OrganizationWithUsers extends Organization {
  users: string[]; // Array of user IDs associated with the organization
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  userId: string; // ID of the user creating the organization
}


