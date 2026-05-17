// App.tsx

import Dashboard from './Dashboard.tsx';
import Joystick from './Joystick.tsx';

export default function App() {
  const isJoystick = window.location.pathname.startsWith('/joystick');
  return isJoystick ? <Joystick /> : <Dashboard />;

}