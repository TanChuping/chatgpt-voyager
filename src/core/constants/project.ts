export const PROJECT_REPOSITORY_URL = 'https://github.com/TanChuping/chatgpt-voyager';
export const ORIGINAL_PROJECT_URL = 'https://github.com/Nagi-ovo/gemini-voyager';
export const SUPPORT_GOAL_JSON_URL =
  'https://raw.githubusercontent.com/TanChuping/chatgpt-voyager-support/refs/heads/main/support-goal.json';

/**
 * Hot-update announcement feed. Lives in the same support-bucket repo as
 * `support-goal.json` rather than a dedicated repo — keeps the
 * release-management surface small (one place to push, one set of `gh`
 * credentials), and reuses the existing `manage-support-goal.cmd` toolchain
 * shape via the parallel `manage-announcement.cmd` GUI. See
 * `src/pages/content/announcement/service.ts` for fetch + dedupe.
 */
export const ANNOUNCEMENT_JSON_URL =
  'https://raw.githubusercontent.com/TanChuping/chatgpt-voyager-support/refs/heads/main/announcements.json';
