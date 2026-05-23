import { useCallback, useEffect, useRef, useState } from 'react';
import type { RobotState } from './types.ts';
import { publishAdminEnable, publishCmdVel, publishRawValue, startZenohSession, startZenohSubscription } from './zenoh.ts';
import './AdminDashboard.css';

const NUM_ROBOTS = 10;
const OVERRIDE_RATE_MS = 25;
const BASE_RADIUS = 130;
const THUMB_RADIUS = 40;
const MAX_OFFSET = BASE_RADIUS - THUMB_RADIUS;

type ConnectionStatus = 'connecting' | 'online' | 'error';

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

function useAdminRobots() {
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('connecting');
  const [states, setStates] = useState<RobotState[]>(
    Array.from({ length: NUM_ROBOTS }, (_, i) => ({ id: i + 1, uptime_s: null })),
  );
  const timeouts = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const cleanups: (() => void)[] = [];
    const robotTimeouts = timeouts.current;
    let cancelled = false;

    async function connectAllRobots() {
      try {
        await startZenohSession();
        if (cancelled) return;
        setConnStatus('online');

        for (let i = 1; i <= NUM_ROBOTS; i++) {
          const cleanup = await startZenohSubscription(`robot/${i}/state`, (robotId, uptime_s) => {
            setStates(prev =>
              prev.map(r => (r.id === robotId ? { ...r, uptime_s } : r)),
            );

            if (robotTimeouts[robotId]) {
              clearTimeout(robotTimeouts[robotId]);
            }

            robotTimeouts[robotId] = setTimeout(() => {
              setStates(prev =>
                prev.map(r => (r.id === robotId ? { ...r, uptime_s: null } : r)),
              );
            }, 3000);
          });

          cleanups.push(cleanup);
        }
      } catch (error) {
        console.error('[admin] failed to open zenoh session:', error);
        setConnStatus('error');
      }
    }

    connectAllRobots();

    return () => {
      cancelled = true;
      cleanups.forEach(fn => fn());
      Object.values(robotTimeouts).forEach(clearTimeout);
    };
  }, []);

  return { connStatus, states };
}

export default function AdminDashboard() {
  const clock = useClock();
  const { connStatus, states } = useAdminRobots();
  const [selectedRobot, setSelectedRobot] = useState(1);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [linear, setLinear] = useState(0);
  const [angular, setAngular] = useState(0);
  const baseRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const joyData = useRef({ linear: 0, angular: 0, active: false });
  const hasSentStop = useRef(false);
  const canControlRef = useRef(false);
  const isConnectedRef = useRef(false);
  const overrideEnabledRef = useRef(false);

  const selectedState = states.find(robot => robot.id === selectedRobot);
  const selectedOnline = selectedState?.uptime_s !== null;
  const robotKey = `robot/${selectedRobot}`;

  function resetJoystickDom() {
    thumbRef.current?.classList.remove('active');
    if (thumbRef.current) {
      thumbRef.current.style.transform = 'translate(-50%, -50%)';
    }
    joyData.current = { linear: 0, angular: 0, active: false };
  }

  function resetJoystick() {
    resetJoystickDom();
    setLinear(0);
    setAngular(0);
  }

  const publishOverrideLock = useCallback((enabled: boolean) => {
    publishAdminEnable(robotKey, enabled);
    publishRawValue('admin_enable', enabled ? '1' : '0');
  }, [robotKey]);

  useEffect(() => {
    isConnectedRef.current = connStatus === 'online';
    overrideEnabledRef.current = overrideEnabled;
    canControlRef.current = overrideEnabled && connStatus === 'online';
    if (connStatus === 'online') {
      publishOverrideLock(overrideEnabled);
    }
    if (!canControlRef.current) {
      resetJoystickDom();
    }
  }, [connStatus, overrideEnabled, publishOverrideLock]);

  useEffect(() => {
    const baseEl = baseRef.current;
    const thumbEl = thumbRef.current;

    if (!baseEl || !thumbEl) return;
    const base = baseEl;
    const thumb = thumbEl;

    let originX = 0;
    let originY = 0;

    function clampToCircle(dx: number, dy: number) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > MAX_OFFSET) {
        const scale = MAX_OFFSET / dist;
        return { x: dx * scale, y: dy * scale };
      }
      return { x: dx, y: dy };
    }

    function update(clientX: number, clientY: number, active: boolean) {
      const raw = { x: clientX - originX, y: clientY - originY };
      const { x, y } = clampToCircle(raw.x, raw.y);
      const nextLinear = parseFloat((-y / MAX_OFFSET).toFixed(3));
      const nextAngular = parseFloat((x / MAX_OFFSET).toFixed(3));

      thumb.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
      joyData.current = { linear: nextLinear, angular: nextAngular, active };
      setLinear(nextLinear);
      setAngular(nextAngular);
    }

    function onStart(clientX: number, clientY: number) {
      if (!isConnectedRef.current) return;
      if (!overrideEnabledRef.current) {
        overrideEnabledRef.current = true;
        canControlRef.current = true;
        setOverrideEnabled(true);
      }
      const rect = base.getBoundingClientRect();
      originX = rect.left + rect.width / 2;
      originY = rect.top + rect.height / 2;
      thumb.classList.add('active');
      update(clientX, clientY, true);
    }

    function onMove(clientX: number, clientY: number) {
      if (!joyData.current.active || !canControlRef.current) return;
      update(clientX, clientY, true);
    }

    function onEnd() {
      if (!joyData.current.active) return;
      thumb.classList.remove('active');
      thumb.style.transform = 'translate(-50%, -50%)';
      joyData.current = { linear: 0, angular: 0, active: false };
      setLinear(0);
      setAngular(0);
    }

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      onStart(e.touches[0].clientX, e.touches[0].clientY);
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      onMove(e.touches[0].clientX, e.touches[0].clientY);
    };
    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      onEnd();
    };

    const onMouseDown = (e: MouseEvent) => onStart(e.clientX, e.clientY);
    const onMouseMove = (e: MouseEvent) => {
      if (e.buttons === 1) onMove(e.clientX, e.clientY);
    };
    const onMouseUp = () => onEnd();

    base.addEventListener('touchstart', onTouchStart, { passive: false });
    base.addEventListener('touchmove', onTouchMove, { passive: false });
    base.addEventListener('touchend', onTouchEnd, { passive: false });
    base.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      base.removeEventListener('touchstart', onTouchStart);
      base.removeEventListener('touchmove', onTouchMove);
      base.removeEventListener('touchend', onTouchEnd);
      base.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (overrideEnabledRef.current && isConnectedRef.current && joyData.current.active) {
        publishCmdVel(robotKey, joyData.current.linear, joyData.current.angular);
        publishOverrideLock(true);
        hasSentStop.current = false;
      } else if (overrideEnabledRef.current && isConnectedRef.current) {
        publishOverrideLock(true);
        publishCmdVel(robotKey, 0, 0);
        hasSentStop.current = true;
      } else if (!hasSentStop.current) {
        publishOverrideLock(false);
        publishCmdVel(robotKey, 0, 0);
        hasSentStop.current = true;
      }
    }, OVERRIDE_RATE_MS);

    return () => clearInterval(id);
  }, [connStatus, overrideEnabled, publishOverrideLock, robotKey]);

  useEffect(() => {
    if (!overrideEnabled || connStatus !== 'online') return;

    publishOverrideLock(true);
    const id = setInterval(() => publishOverrideLock(true), 250);

    return () => clearInterval(id);
  }, [connStatus, overrideEnabled, publishOverrideLock, robotKey]);

  useEffect(() => {
    resetJoystickDom();
    publishOverrideLock(false);
    publishCmdVel(robotKey, 0, 0);
  }, [publishOverrideLock, robotKey]);

  function disableOverride() {
    overrideEnabledRef.current = false;
    canControlRef.current = false;
    setOverrideEnabled(false);
    resetJoystick();
    publishOverrideLock(false);
    publishCmdVel(robotKey, 0, 0);
  }

  function selectRobot(robotId: number) {
    disableOverride();
    setSelectedRobot(robotId);
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div>
          <h1>ADMIN DASHBOARD</h1>
          <span className={`admin-status ${connStatus}`}>
            {connStatus === 'online' ? 'zenoh connected' : connStatus === 'connecting' ? 'connecting' : 'router offline'}
          </span>
        </div>
        <span className="admin-clock">{clock}</span>
      </header>

      <main className="admin-layout">
        <section className="admin-robots" aria-label="Robots">
          {states.map(robot => (
            <button
              className={`admin-robot-button ${robot.id === selectedRobot ? 'selected' : ''} ${robot.uptime_s !== null ? 'online' : ''}`}
              key={robot.id}
              onClick={() => selectRobot(robot.id)}
              type="button"
            >
              <span>ROBOT {robot.id}</span>
              <strong>{formatUptime(robot.uptime_s)}</strong>
            </button>
          ))}
        </section>

        <section className={`override-panel ${overrideEnabled ? 'armed' : ''}`}>
          <div className="override-title-row">
            <div>
              <h2>Robot {selectedRobot}</h2>
              <div className={`connection-status ${selectedOnline ? 'online' : 'offline'}`}>
               {selectedOnline ? 'robot active' : 'robot offline'}
              </div>
              <span className={selectedOnline ? 'robot-online' : 'robot-offline'}>
                {selectedOnline ? `Uptime: ${formatUptime(selectedState?.uptime_s ?? null)}` : 'offline'}
              </span>
            </div>
            <label className="override-toggle">
              <input
                checked={overrideEnabled}
                disabled={connStatus !== 'online'}
                onChange={event => {
                  if (event.target.checked) {
                    setOverrideEnabled(true);
                  } else {
                    disableOverride();
                  }
                }}
                type="checkbox"
              />
              <span>Override</span>
            </label>
          </div>

          <div className={`admin-joystick-area ${overrideEnabled && connStatus === 'online' ? '' : 'disabled'}`}>
            <div className="admin-joystick-base" ref={baseRef}>
              <div className="admin-joystick-thumb" ref={thumbRef} style={{ transform: 'translate(-50%, -50%)' }} />
            </div>
          </div>

          <div className="joystick-values">
            <div>linear&nbsp; <span>{linear.toFixed(2)}</span></div>
            <div>angular <span>{angular.toFixed(2)}</span></div>
          </div>


          {/* <button className="release-button" onClick={disableOverride} type="button">
            Release Joystick Control
          </button> */}
        </section>
      </main>
    </div>
  );
}
