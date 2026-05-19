/**
 * Workspaces are GA for the Researcher tier (PROMPT_7 Track E). The old
 * "coming soon" toggle is replaced by a tier-aware gate — non-Researcher
 * tiers see the chrome but get an upgrade tooltip on interaction.
 *
 * Use `canAccess(tier, "workspace")` from `UserTierContext` to drive
 * actual gating; the constant below stays exported as `false` so any
 * call-site that still imports it short-circuits to "not disabled".
 */
export const WORKSPACE_FEATURES_TEMPORARILY_DISABLED = false;

/** Tooltip for non-Researcher tiers attempting to use workspaces. */
export const WORKSPACE_FEATURES_TIER_LOCKED_TOOLTIP =
  "Workspaces are part of the Researcher plan. Upgrade in Settings to add papers to a session and save workspaces.";

/** Maximum papers per workspace session (PROMPT_7 follow-up). */
export const MAX_SESSION_PAPERS = 3;

/** User-facing message when trying to exceed the workspace cap. */
export const WORKSPACE_PAPER_LIMIT_MESSAGE = `Workspace limit reached (${MAX_SESSION_PAPERS} papers). Remove one to add another.`;

/** @deprecated PROMPT_7: replaced by WORKSPACE_FEATURES_TIER_LOCKED_TOOLTIP. */
export const WORKSPACE_FEATURES_COMING_SOON_TOOLTIP =
  WORKSPACE_FEATURES_TIER_LOCKED_TOOLTIP;
