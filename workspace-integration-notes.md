# Workspace Integration Notes

ASTRA currently runs on the established Node.js, tRPC, Drizzle, and managed MySQL foundation rather than a Supabase client. Workspace access will therefore be enforced in trusted server-side procedures using the authenticated `ctx.user` identity, organization IDs, and verified workspace membership; the data model remains compatible with a future Supabase RLS migration.

The existing `users`, `organizations`, `organizationMembers`, and `auditLogs` tables are the shared foundation. The workspace feature will add organization-scoped workspaces, workspace memberships, pending invitations, declared data-environment records, and a workspace ID on audit entries without rebuilding existing authentication or dashboard surfaces.

Workspace roles are separate from the existing organization role. OWNER and ADMIN will be validated server-side before sensitive membership and configuration mutations; OWNER records cannot be changed or removed through the normal role/removal flows.
