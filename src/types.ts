// types.ts
// Shared types for the workshop dashboard

export interface RobotState {
  id: number;        // 1–10
  uptime_s: number | null;  // seconds since boot, null if never seen
}