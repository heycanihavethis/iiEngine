// Public aliases of the generated backend response schemas.
import type { components } from './api';
export type Role = components['schemas']['RoleView'];
export type Member = components['schemas']['MemberView'];
export type Announcement = components['schemas']['AnnouncementView'];
export type Dashboard = components['schemas']['DashboardView'];
export type HealthItem = {
  name: string;
  status: 'Healthy' | 'Warning' | 'Error' | 'Unknown';
  detail: string;
};
