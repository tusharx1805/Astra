# Project TODO

- [x] Establish the brutalist dark ASTRA visual system with black canvas, condensed typography, a vivid red structural divider, and responsive behavior.
- [x] Build the persistent, role-aware application navigation and authenticated account foundation.
- [x] Create the dashboard with project metrics, pipeline health, risk overview, recent changes, and simulated-data disclosure.
- [x] Implement the deterministic mock risk engine contract and sample operational data model.
- [x] Build the Change Intelligence workspace with editable change input, analysis stages, scored risk result, and simulated disclosure.
- [x] Implement reviewer decision recording with role-aware action controls and audit-ready history.
- [x] Send owner notifications after simulated risk analysis completion and review-decision changes.
- [x] Build lineage and blast-radius workspaces that connect affected pipelines, datasets, owners, and dependencies.
- [x] Create pipelines, data-quality, incidents, monitoring, and internal-agent operational workspaces with clearly labeled simulated data.
- [x] Add projects and admin/account surfaces with a Supabase-ready RBAC architecture and Node.js plus tRPC backend foundation.
- [x] Add unit tests for deterministic risk analysis, review decision permissions, and owner-notification dispatch including unavailable-channel fallback.
- [x] Verify desktop and mobile rendering, accessibility foundations, empty/error/loading states, and disclosure placement.
- [x] Extend the schema and server foundation with organization-scoped workspaces, members, invitations, data-environment selections, and workspace audit events.
- [x] Implement workspace permission rules: owner safeguards, admin member controls, and read-only developer/reviewer/viewer restrictions for member administration.
- [x] Build functional workspace creation, creator-as-owner assignment, setup, and data-environment persistence.
- [x] Add an organization workspace switcher and workspace overview without modifying unrelated ASTRA dashboards.
- [x] Build member listing, pending invitations, role changes, removal confirmations, and appropriate permission-gated actions.
- [x] Add unit coverage for workspace access isolation, setup, invitation, role-change, and removal authorization; verify responsive workspace entry and overview states.

- [x] Add a provider-based global command palette with live filtering, grouped results, keyboard navigation, recents, simulated badges, and graceful provider failures.
- [x] Formalize the sidebar into BUILD, INTELLIGENCE, and REPORTS groups while keeping Workspaces, Account & Admin, and Settings pinned.
- [x] Add deep-linkable module sub-navigation and useful sub-pages for Datasets, Pipelines, Changes, Risk Analysis, Monitoring, and Reports.
- [x] Populate real-backed workspace results for search and filtered operational views without adding new backend tables.
- [x] Add loading, empty, filter, sort, and row-navigation states across every new module destination.
- [x] Add tests and responsive verification for search, navigation, and sub-page routing while preserving the existing ASTRA visual system.

# Search and navigation implementation notes
- [x] Inspect the existing ASTRA shell, module data contracts, and mock fixtures before wiring new destinations.
- [x] Avoid new backend tables and new visual motifs; use existing workspace-scoped data and route-level views.
- [x] Keep changes, incidents, risk analysis, and related intelligence results explicitly simulated.
- [x] Ensure search results remain permission-filtered by workspace membership and server-side access rules.
- [x] Keep recent-search state in React/session state only; do not add localStorage for search recents.
- [x] Preserve the current ASTRA dashboard and workspace behavior while adding deep links.
- [x] Verify every required page has an explicit loading or skeleton state, an empty state, and no dead-end row actions.
- [x] Re-run TypeScript checks and the full test suite before the next checkpoint.
- [x] Save a new checkpoint only after all new search and navigation work is validated.
- [x] Do not implement search ranking, typo tolerance, new backend tables, or new intelligence backends in this phase.
- [x] Do not redesign the current dark visual language, tokens, typography, or card/border system.
- [x] Do not add new RLS policies unless a genuinely new table is introduced; these module destinations are views/filters over existing data.
- [x] Do not build command-palette actions beyond navigation in this phase.
- [x] Do not make Changes/Risk Analysis real-backed in this phase; keep them browsable/searchable mock fixtures.
- [x] Do not modify unrelated ASTRA page data or visual treatments beyond the required navigation integration.
- [x] Do not add new charts or new color meanings; reuse existing visual language and states.
- [x] Do not claim relevance ranking or live search indexing in UI copy.
- [x] Do not surface scary toasts for individual search provider misses; silently omit failed groups and log the error.
- [x] Do not introduce a separate nested sidebar flyout; keep secondary navigation inside module pages.
- [x] Do not create a separate connections or runs table; use existing dataset source and pipeline run views.
- [x] Do not add client-storage or external services for recents or query ranking.
- [x] Do not allow search to expose results outside the active workspace or beyond visible role permissions.
- [x] Do not leave any module sub-page as a blank stub; each must explain its data state.
- [x] Do not add a new layout or component pattern when an existing Tabs, Dialog, filter, or table primitive already fits.
- [x] Do not remove or rename existing top-level routes; only extend them with deep-linkable sub-routes.
- [x] Do not add new workspace/member permission rules in this phase; inherit the established parent-module rules.
- [x] Do not add a backend search index or full-text/fuzzy search implementation.
- [x] Do not add export flows beyond the specified client-side CSV report export.
- [x] Do not add non-functional decorative controls without a toast or a real route/action.
- [x] Do not skip responsive verification for the command palette, sidebar groups, tabs, and table views.
- [x] Do not finalize delivery without reading this todo file and confirming all implementation items are checked.
- [x] Do not create a new checkpoint before tests, screenshots, and runtime logs are clean.
- [x] Do not treat screenshot verification as a substitute for Vitest coverage.
- [x] Do not change the project’s authenticated data access architecture while adding search.
- [x] Do not add new auth or profile permissions beyond inherited workspace and admin visibility rules.
- [x] Do not expose simulated badges only in detail pages; show them in search results and mock-backed list views too.
- [x] Do not let arrow-key navigation skip visible search results across grouped entity sections.
- [x] Do not let empty search shortcuts bypass role/visibility logic already used by the sidebar.
- [x] Do not use localStorage for recents; keep them in React state/session memory.
- [x] Do not show more than five results per entity group before the View all row.
- [x] Do not make search input navigation dependent on a mouse-only interaction.
- [x] Do not make the command palette inaccessible to Ctrl+K on non-macOS browsers.
- [x] Do not add new visual styles to search results that conflict with existing badge and severity language.
- [x] Do not create a second tab component; reuse the existing Tabs primitive.
- [x] Do not create a new table pattern; reuse the existing ASTRA table treatment.
- [x] Do not omit route-level filters where the brief specifies status/date/source filtering.
- [x] Do not route rows to dead ends; connect runs to execution pages and dataset connections to filtered dataset views.
- [x] Do not break the pinned bottom navigation while formalizing upper sidebar groups.
- [x] Do not change Workspaces, Account & Admin, or Settings into nested sidebar flyouts.
- [x] Do not surface unscoped project/dataset/pipeline results to viewers.
- [x] Do not use simulated data language for real-backed projects, datasets, or pipelines.
- [x] Do not omit clear simulated-data disclosure on mock Changes, Incidents, Risk Analysis, and Monitoring views.
- [x] Do not invent customer reviews, ratings, or testimonials.
- [x] Do not publish or deploy; save the checkpoint and hand off through the project UI.
- [x] Do not finish until the user can open search by click and keyboard, navigate results, and press Enter to route.
- [x] Do not finish until all required sub-navigation URLs render from direct navigation.
- [x] Do not finish until a provider error cannot break the entire search palette.
- [x] Do not finish until the sidebar group labels are visibly BUILD, INTELLIGENCE, and REPORTS.
- [x] Do not finish until project/dashboard routes remain intact after navigation changes.
- [x] Do not finish until desktop and mobile screenshots are reviewed.
- [x] Do not finish until the final checkpoint includes only validated changes.

# Validation gap follow-ups
- [x] Add the missing visible INTELLIGENCE sidebar group label and verify primary nav grouping.
- [x] Add non-dead-end dataset and pipeline detail routes for row navigation.
- [x] Add explicit sort controls and states to the module list views.
- [x] Add unit coverage for command-palette keyboard behavior and route/sub-page mapping.
- [x] Re-run checks and screenshots after the follow-up fixes, then save a new checkpoint.

# Final validation follow-up
- [x] Add a component-level CommandPalette keyboard test covering ArrowDown/ArrowUp selection and Enter navigation.
- [x] Save a new checkpoint after the component-level test and final runtime verification.

# ASTRA navigation and data work
- [x] Restructure the sidebar into the flat utility tier plus EXPLORE, DATA ENGINEERING, and INTELLIGENCE groups without adding out-of-scope compute or ML-infrastructure pages.
- [x] Add persisted recently_viewed records, secure queries, and one shared detail-page tracking helper.
- [x] Add saved_queries and query_runs persistence with workspace-role authorization and audit actions.
- [x] Add ingestion-attempt and dataset-connection persistence or reuse an existing safe ingestion contract for the Data Ingestion hub.
- [x] Add CSV-backed client query execution and real query history logging without a new query engine.
- [x] Build Recents, Integrations, Saved Queries, Query History, Pipeline Runs, and Data Ingestion pages with loading, empty, filter, and no-dead-end states.
- [x] Add the + New quick-create dropdown and connect its options to existing creation flows.
- [x] Register all new pages and Saved Queries with the existing SearchProvider and command palette.
- [x] Add audit log entries for DATASET_CONNECTED_VIA_INTEGRATIONS, SAVED_QUERY_CREATED, and SAVED_QUERY_RUN.
- [x] Add tests for recent tracking, saved-query permissions, CSV execution, search registration, and route coverage.
- [x] Re-run typecheck, tests, responsive screenshots, and runtime-log verification; then save a final checkpoint.

# ASTRA navigation and data implementation constraints
- [x] Do not add Compute, notebooks, SQL Warehouses, model training/serving, AI Gateway, Playground, or other out-of-scope competitor-pattern pages.
- [x] Do not create new visual language; reuse existing ASTRA cards, tables, badges, tabs, and modals.
- [x] Do not add a separate connections or runs table when an existing safe contract already covers the view.
- [x] Do not use localStorage for recents; use persisted recent-view records and session React state where appropriate.
- [x] Do not expose data outside the active workspace; enforce membership and role permissions in every server procedure.
- [x] Do not make non-CSV sources appear connected; show Available only for CSV / Files and Coming soon for other connector cards.
- [x] Do not make simulated Changes, Risk Analysis, Incidents, or Monitoring data look real-backed.
- [x] Do not add new creation logic where existing creation modal/flow can be reused.
- [x] Do not add a second command-palette implementation or a separate navigation system.
- [x] Do not leave any new page as a blank stub or dead-end table.
- [x] Do not add client-side query execution that runs arbitrary server SQL; execute only against already-loaded preview CSV data.
- [x] Do not add a full-text search index, ranking model, typo tolerance, or external search service.
- [x] Do not add new RLS policies unless genuinely new tables are introduced; follow the existing workspace-role helper pattern if they are.
- [x] Do not add new authentication or profile permission rules; inherit workspace and admin visibility.
- [x] Do not introduce customer reviews, ratings, or testimonials.
- [x] Do not publish or deploy; checkpoint only and hand off through the project UI.
- [x] Do not finish until all direct URLs render and all required pages have loading and empty states.
- [x] Do not finish until the sidebar groups visibly read BUILD-equivalent utility, EXPLORE, DATA ENGINEERING, and INTELLIGENCE structure.
- [x] Do not finish until the user can create a workspace resource from + New or is given an honest unavailable state.
- [x] Do not finish until a detail-page mount writes a recent-view entry through the shared helper.
- [x] Do not finish until saved-query creation and run actions are role-gated and auditable.
- [x] Do not finish until command-palette search includes Recents, Catalog, Integrations, Saved Queries, Query History, Pipeline Runs, Data Ingestion, and Dashboards.
- [x] Do not finish until desktop and mobile screenshots are reviewed and the full Vitest suite passes.

# Validation gaps discovered after implementation review
- [x] Add explicit tests for recent-view persistence helper behavior and mount-time procedure invocation contract.
- [x] Add explicit tests proving saved-query create/run actions reject unauthorized workspace roles and write audit events.
- [x] Verify the latest runtime logs after the navigation/data changes and confirm no active compile or runtime errors.
- [x] Save a fresh checkpoint after these validation-gap fixes.

# Real ingestion and pipeline execution
- [x] Add the workspace-scoped encrypted PostgreSQL connection contract with server-only credential handling; persistence remains fail-closed until CONNECTION_ENCRYPTION_KEY is supplied.
- [x] Add capped development-fixture row snapshots and structured dataset statistics for the fixture-backed dataset flow; live CSV/PostgreSQL persistence remains pending.
- [x] Add ordered pipeline transformation steps and concrete source/destination fields.
- [x] Implement safe fixture-mode PostgreSQL test/table-browse responses, read-only SQL validation, and snapshot-ingestion contracts; live network import remains gated.
- [x] Normalize the development CSV fixture into capped dataset row snapshots without changing the existing upload UX; live upload persistence remains deferred.
- [x] Implement pure isomorphic transform steps: filter, rename, datatype conversion, drop column, and remove nulls.
- [x] Add live transformation preview and concrete Source → Transformation → Destination pipeline builder controls.
- [x] Make fixture-mode Run Pipeline execute bounded rows, write destinations after successful transforms, and record run metrics/logs/coercion failures; production DB atomics remain gated.
- [x] Replace the requested dashboard KPI cards with workspace-scoped fixture aggregates and disclosure-safe loading states; live warehouse aggregates remain deferred.
- [x] Preserve simulated intelligence modules, existing ASTRA visual language, manual-only fixture execution, and all listed scope exclusions.
- [x] Add required encryption-secret handling, fail-closed behavior, read-only SQL validation, and tests proving PostgreSQL passwords are never logged or returned.
- [x] Add server/client tests for fixture transformations, stats, execution, fixture-route workspace authorization, and disclosure behavior; live SQL and aggregate coverage remains pending.
- [x] Verify desktop/mobile pages, post-change runtime logs, typecheck, full tests, and save a fixture-mode checkpoint.

# Fixture-mode continuation
- [x] Implement clearly labeled development fixture rows and connector stubs for CSV/PostgreSQL flows.
- [x] Keep real PostgreSQL credential encryption and network connection disabled until CONNECTION_ENCRYPTION_KEY is supplied.
- [x] Show fixture-mode disclosures wherever dummy rows, imports, or execution results are displayed.
- [x] Record production follow-up: request CONNECTION_ENCRYPTION_KEY before enabling credential persistence or live PostgreSQL imports.
- [x] Extend the fixture pipeline builder to add, remove, and reorder all five supported transformation operations.
- [x] Add coverage proving multi-step preview and execution parity across every supported operation, included in Vitest discovery.
