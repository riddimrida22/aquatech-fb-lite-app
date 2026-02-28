export type AppUserLike = {
  role?: string | null;
  permissions?: string[] | null;
};

export function hasPermission(user: AppUserLike | null | undefined, permission: string): boolean {
  return !!user?.permissions?.includes(permission);
}

export function deriveUserCapabilities(user: AppUserLike | null | undefined) {
  const canManageUsers = hasPermission(user, "MANAGE_USERS");
  const canManageProjects = hasPermission(user, "MANAGE_PROJECTS");
  const canManageRates = hasPermission(user, "MANAGE_RATES");
  const canApproveTimesheets = hasPermission(user, "APPROVE_TIMESHEETS");
  const canViewFinancials = hasPermission(user, "VIEW_FINANCIALS");
  const canViewOperations = canViewFinancials || canManageRates;
  return {
    canManageUsers,
    canManageProjects,
    canManageRates,
    canApproveTimesheets,
    canViewFinancials,
    canViewOperations,
  };
}
