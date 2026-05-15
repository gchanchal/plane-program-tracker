/**
 * Mutable app state. Imported as a singleton object so any module can
 * read/write the same fields. Keep this small — only data that has to be
 * shared across modules.
 */
export const state = {
  DATA: null,             // Latest /api/data response for the current project
  HISTORY: [],            // Snapshots from /api/history (for CFD)
  PROJECTS: [],           // From /api/projects
  CURRENT_PROJECT_ID: null,
  CURRENT_ACTIONS: null,  // Computed action buckets, cached so risk-strip + KPIs can read
  CHART_INSTANCES: {},    // id -> ECharts instance
};
