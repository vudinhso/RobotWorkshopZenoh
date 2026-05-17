// Dashboard.tsx
// Shows 10 robot cards. Each card has a QR code and displays uptime from robot*/state.

import { useEffect, useState, useRef } from 'react';
import * as QRCode from 'qrcode';
import type { RobotState } from './types.ts';
import { startZenohSubscription, startZenohSession } from './zenoh.ts';

import './Dashboard.css';


const NUM_ROBOTS = 10;

const joystickUrl = (n: number) =>
  `http://${window.location.host}/joystick.html?robot=${n}`;
 
function formatUptime(seconds: number | null): string {
  if (seconds === null) return 'offline';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
 
function useClock(): string {
  const [time, setTime] = useState(() => new Date().toTimeString().slice(0, 8));
  useEffect(() => {
    const id = setInterval(() => setTime(new Date().toTimeString().slice(0, 8)), 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}
 
function useRobotStates(): RobotState[] {
  const [states, setStates] = useState<RobotState[]>(
    Array.from({ length: NUM_ROBOTS }, (_, i) => ({ id: i + 1, uptime_s: null }))
  );

  const timeouts = useRef<Record<number, NodeJS.Timeout>>({});

  useEffect(() => {
    const cleanups: (() => void)[] = [];

    async function connectAllRobots() {
      
      // THE FIX: Open the shared Zenoh WebSocket connection first!
      await startZenohSession();

      // Now it is safe to loop and subscribe
      for (let i = 1; i <= NUM_ROBOTS; i++) {
        // NOTE: If you changed your C++ code to use "robot/1/state", 
        // make sure this string is `robot/${i}/state` instead!
        const topic = `robot/${i}/state`;

        const cleanup = await startZenohSubscription(topic, (robotId, uptime_s) => {
          setStates(prev =>
            prev.map(r => (r.id === robotId ? { ...r, uptime_s } : r))
          );

          if (timeouts.current[robotId]) {
            clearTimeout(timeouts.current[robotId]);
          }

          timeouts.current[robotId] = setTimeout(() => {
            setStates(prev =>
              prev.map(r => (r.id === robotId ? { ...r, uptime_s: null } : r))
            );
          }, 3000);
        });

        if (cleanup) cleanups.push(cleanup);
      }
    }

    connectAllRobots();

    return () => {
      cleanups.forEach(fn => fn());
      Object.values(timeouts.current).forEach(clearTimeout);
    };
  }, []);

  return states;
}
 
// ── RobotCard ─────────────────────────────────────────────
 
interface RobotCardProps {
  robot: RobotState;
}
 
function RobotCard({ robot }: RobotCardProps) {
  const url = joystickUrl(robot.id);
  const isOnline = robot.uptime_s !== null;
 
  // Draw QR code into <canvas> after mount
  useEffect(() => {
    const canvas = document.getElementById(`qr-${robot.id}`) as HTMLCanvasElement;
    if (canvas) {
      QRCode.toCanvas(canvas, url, { width: 160, margin: 1 });
    }
  }, [url, robot.id]);
 
  return (
    <div className={`robot-card ${isOnline ? 'online' : ''}`}>
      <div className="card-header">
        <span className="card-title">ROBOT {robot.id}</span>
        <span className={`card-uptime ${isOnline ? 'online' : ''}`}>
          {formatUptime(robot.uptime_s)}
        </span>
      </div>
 
      <div className="qr-wrapper">
        <canvas id={`qr-${robot.id}`} />
      </div>
 
      <div className="card-url">{url}</div>
    </div>
  );
}
 
// ── Dashboard ─────────────────────────────────────────────
 
export default function Dashboard() {
  const clock = useClock();
  const robots = useRobotStates();
 
  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <h1>ZENOH WORKSHOP</h1>
        <span className="dashboard-clock">{clock}</span>
      </header>
 
      <main className="robot-grid">
        {robots.map(robot => (
          <RobotCard key={robot.id} robot={robot} />
        ))}
      </main>
    </div>
  );
}