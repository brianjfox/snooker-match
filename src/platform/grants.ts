/**
 * GrantManifest — local shim for platform grants (plan task 10).
 *
 * Two principals: the operator (launching principal, full correct authority)
 * and TV viewers (read-only). The hub resolves the role per request; on the
 * real platform the hub resolves grants at launch against the principal.
 */

import type { GrantManifest, Role } from "../types.ts";

export const GRANT_MANIFEST: GrantManifest = {
  roles: {
    operator: { read: true, correct: true },
    viewer: { read: true, correct: false },
  },
};

/**
 * Resolve the request's role. The TV view and any request that explicitly
 * identifies as a viewer get the read-only grant; the tablet's control UI
 * identifies as operator. Defaults to viewer (least authority).
 */
export function resolveRole(req: Request): Role {
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("role");
  const fromHeader = req.headers.get("x-role");
  const role = fromHeader ?? fromQuery ?? "viewer";
  return role === "operator" ? "operator" : "viewer";
}

export function canCorrect(role: Role): boolean {
  return GRANT_MANIFEST.roles[role].correct;
}
