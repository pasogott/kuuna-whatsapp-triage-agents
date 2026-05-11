import { isAdminRole } from "@/lib/permissions/matrix";
import type { StaffUser } from "@/lib/api-client/types";

export const REQUIRED_ADMIN_EMAIL = (
  process.env.REQUIRED_ADMIN_EMAIL ?? "admin@kuuna.ai"
).toLowerCase();

export function isRequiredAdminAccount(user: StaffUser): boolean {
  return user.email.toLowerCase() === REQUIRED_ADMIN_EMAIL;
}

export function hasActiveRequiredAdminAccount(users: StaffUser[]): boolean {
  return users.some(
    (user) =>
      isRequiredAdminAccount(user) &&
      user.active &&
      user.role === "admin",
  );
}

export function activePrivilegedUserCount(users: StaffUser[]): number {
  return users.filter((user) => user.active && isAdminRole(user.role)).length;
}

export function canDeactivateUser(users: StaffUser[], target: StaffUser): boolean {
  if (!target.active) {
    return true;
  }

  if (isRequiredAdminAccount(target)) {
    return false;
  }

  if (!isAdminRole(target.role)) {
    return true;
  }

  const remainingPrivileged = users.filter(
    (user) => user.id !== target.id && user.active && isAdminRole(user.role),
  ).length;

  return remainingPrivileged >= 1;
}

export function canDeleteUser(users: StaffUser[], target: StaffUser): boolean {
  if (isRequiredAdminAccount(target)) {
    return false;
  }

  if (!target.active || !isAdminRole(target.role)) {
    return true;
  }

  const remainingPrivileged = users.filter(
    (user) => user.id !== target.id && user.active && isAdminRole(user.role),
  ).length;

  return remainingPrivileged >= 1;
}
