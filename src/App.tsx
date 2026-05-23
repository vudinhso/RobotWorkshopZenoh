// App.tsx

import Dashboard from './Dashboard.tsx';
import Joystick from './Joystick.tsx';
import AdminDashboard from './AdminDashboard.tsx';

export default function App() {
  const isAdmin = window.location.pathname.startsWith('/admin');
  const isJoystick = window.location.pathname.startsWith('/joystick');
  if (isAdmin) return <AdminDashboard />;
  return isJoystick ? <Joystick /> : <Dashboard />;

}
