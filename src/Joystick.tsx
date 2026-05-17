// Joystick.tsx
import { useEffect, useRef, useState } from 'react';
import { publishCmdVel, startZenohSession } from './zenoh';
// Import the robust helper function you created
import { startZenohSubscription } from './zenoh'; 
import './Joystick.css';

const PUBLISH_RATE_MS = 50; // 20 Hz
const BASE_RADIUS = 130;
const THUMB_RADIUS = 40;
const MAX_OFFSET = BASE_RADIUS - THUMB_RADIUS;

function getRobotNumber(): number {
  const params = new URLSearchParams(window.location.search);
  const n = parseInt(params.get('robot') ?? '1');
  return isNaN(n) ? 1 : n;
}

// Quick helper to format raw seconds into a readable timer
function formatUptime(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export default function Joystick() {
  const robotNumber = getRobotNumber();
  const robotKey    = `robot/${robotNumber}`;

  const [connStatus, setConnStatus] = useState<'connecting' | 'online' | 'error'>('connecting');
  
  // NEW: State to hold the specific robot's uptime in seconds
  const [uptime, setUptime] = useState<number | null>(null);

  // NEW: Track the robot's actual heartbeat
  const [isRobotAlive, setIsRobotAlive] = useState<boolean>(false);

  const baseRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const linearTextRef = useRef<HTMLSpanElement>(null);
  const angularTextRef = useRef<HTMLSpanElement>(null);
  const joyData = useRef({ linear: 0, angular: 0, active: false });

  // 1. Establish connection and subscribe to uptime
  useEffect(() => {
    let cleanupSubscription: () => void;

    startZenohSession()
      .then(async () => {
        setConnStatus('online');

        // NEW: Pass the exact topic string (e.g., "robot1/state")
        const exactTopic = `${robotKey}/state`; 
        
        cleanupSubscription = await startZenohSubscription(exactTopic, (id, uptime_s) => {
          if (id === robotNumber) {
            setUptime(uptime_s);
          }
        });
      })
      .catch(() => setConnStatus('error'));

    return () => {
      if (cleanupSubscription) {
        cleanupSubscription();
      }
    };
  }, [robotNumber, robotKey]);

  // 4. The Heartbeat Monitor
  useEffect(() => {
    if (uptime === null) return;

    // We got a pulse! The robot is alive.
    setIsRobotAlive(true);

    // If we don't get another pulse in 2.5 seconds, declare it offline.
    const deathTimer = setTimeout(() => {
      setIsRobotAlive(false);
    }, 2500);

    // Cleanup the timer if a new pulse arrives before it triggers
    return () => clearTimeout(deathTimer);
  }, [uptime]);

  // 2. High-performance Joystick Logic
  useEffect(() => {
    const baseEl = baseRef.current;
    const thumbEl = thumbRef.current;
    const linText = linearTextRef.current;
    const angText = angularTextRef.current;
    
    if (!baseEl || !thumbEl) return;

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

    function onStart(clientX: number, clientY: number) {
      const rect = baseEl!.getBoundingClientRect();
      originX = rect.left + rect.width / 2;
      originY = rect.top + rect.height / 2;
      thumbEl!.classList.add('active');
      update(clientX, clientY, true);
    }

    function onMove(clientX: number, clientY: number) {
      update(clientX, clientY, true);
    }

    function onEnd() {
      thumbEl!.classList.remove('active');
      thumbEl!.style.transform = `translate(-50%, -50%)`;
      joyData.current = { linear: 0, angular: 0, active: false };
      
      if (linText) linText.innerText = "0.00";
      if (angText) angText.innerText = "0.00";
    }

    function update(clientX: number, clientY: number, active: boolean) {
      const raw = { x: clientX - originX, y: clientY - originY };
      const { x, y } = clampToCircle(raw.x, raw.y);
      
      thumbEl!.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;

      const linear = parseFloat((-y / MAX_OFFSET).toFixed(3));
      const angular = parseFloat((x / MAX_OFFSET).toFixed(3));

      joyData.current = { linear, angular, active };
      
      if (linText) linText.innerText = linear.toFixed(2);
      if (angText) angText.innerText = angular.toFixed(2);
    }

    const onTouchStart = (e: TouchEvent) => { e.preventDefault(); onStart(e.touches[0].clientX, e.touches[0].clientY); };
    const onTouchMove  = (e: TouchEvent) => { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); };
    const onTouchEnd   = (e: TouchEvent) => { e.preventDefault(); onEnd(); };

    const onMouseDown = (e: MouseEvent) => onStart(e.clientX, e.clientY);
    const onMouseMove = (e: MouseEvent) => { if (e.buttons === 1) onMove(e.clientX, e.clientY); };
    const onMouseUp   = () => onEnd();

    baseEl.addEventListener('touchstart',  onTouchStart, { passive: false });
    baseEl.addEventListener('touchmove',   onTouchMove,  { passive: false });
    baseEl.addEventListener('touchend',    onTouchEnd,   { passive: false });
    baseEl.addEventListener('mousedown',   onMouseDown);
    window.addEventListener('mousemove',   onMouseMove);
    window.addEventListener('mouseup',     onMouseUp);

    return () => {
      baseEl.removeEventListener('touchstart',  onTouchStart);
      baseEl.removeEventListener('touchmove',   onTouchMove);
      baseEl.removeEventListener('touchend',    onTouchEnd);
      baseEl.removeEventListener('mousedown',   onMouseDown);
      window.removeEventListener('mousemove',   onMouseMove);
      window.removeEventListener('mouseup',     onMouseUp);
    };
  }, []);

  // 3. The 20Hz Publisher Loop
  // Add this new ref near your other refs at the top of the component
  const hasSentStop = useRef(false);

  // 3. The FIXED 20Hz Publisher Loop
  useEffect(() => {
    const id = setInterval(() => {
      if (joyData.current.active) {
        // Joystick is moving: publish live data and unlock the stop trigger
        publishCmdVel(robotKey, joyData.current.linear, joyData.current.angular);
        hasSentStop.current = false;
      } 
      else if (!hasSentStop.current) {
        // Joystick was just released: send ONE stop command, then lock it
        publishCmdVel(robotKey, 0, 0);
        hasSentStop.current = true;
      }
    }, PUBLISH_RATE_MS);
    
    return () => clearInterval(id);
  }, [robotKey]);

  return (
    <div className="joystick-page">

      <div className="joystick-header">
        <h1>ROBOT {robotNumber}</h1>
        
        {/* 1. Check the Router connection first */}
        {connStatus === 'error' ? (
          <div className="connection-status error">router offline</div>
        ) : connStatus === 'connecting' ? (
          <div className="connection-status connecting">connecting to router...</div>
        ) : (
          /* 2. If Router is online, display the true Robot Status */
          <div className={`connection-status ${isRobotAlive ? 'online' : 'error'}`}>
            {isRobotAlive ? 'robot active' : 'robot offline'}
          </div>
        )}

        {/* 3. The uptime timer is now tied to the robot being alive */}
        {isRobotAlive && uptime !== null && (
          <div className="robot-uptime" style={{ fontSize: '0.95rem', color: '#888', marginTop: '6px', fontWeight: 500 }}>
            Uptime: {formatUptime(uptime)}
          </div>
        )}
      </div>

      <div className="joystick-area">
        <div className="joystick-base" ref={baseRef}>
          <div className="joystick-thumb" ref={thumbRef} style={{ transform: 'translate(-50%, -50%)' }} />
        </div>
      </div>

      <div className="joystick-values">
        <div>linear&nbsp; <span ref={linearTextRef}>0.00</span></div>
        <div>angular <span ref={angularTextRef}>0.00</span></div>
      </div>

    </div>
  );
}

//======================================================================
//======================================================================

// // Joystick.tsx
// import { useEffect, useRef, useState } from 'react';
// import { publishCmdVel, startZenohSession } from './zenoh';
// import './Joystick.css';

// const PUBLISH_RATE_MS = 50; // 20 Hz
// const BASE_RADIUS = 130;
// const THUMB_RADIUS = 40;
// const MAX_OFFSET = BASE_RADIUS - THUMB_RADIUS;

// function getRobotNumber(): number {
//   const params = new URLSearchParams(window.location.search);
//   const n = parseInt(params.get('robot') ?? '1');
//   return isNaN(n) ? 1 : n;
// }

// export default function Joystick() {
//   const robotNumber = getRobotNumber();
//   const robotKey    = `robot${robotNumber}`;

//   // Connection status changes rarely, so it is safe to use React state
//   const [connStatus, setConnStatus] = useState<'connecting' | 'online' | 'error'>('connecting');
  
//   // Refs for the interactive elements (bypasses React render loop)
//   const baseRef = useRef<HTMLDivElement>(null);
//   const thumbRef = useRef<HTMLDivElement>(null);
  
//   // Refs for the live text values
//   const linearTextRef = useRef<HTMLSpanElement>(null);
//   const angularTextRef = useRef<HTMLSpanElement>(null);

//   // Background math data
//   const joyData = useRef({ linear: 0, angular: 0, active: false });

//   // 1. Establish connection on mount
//   useEffect(() => {
//     startZenohSession()
//       .then(() => setConnStatus('online'))
//       .catch(() => setConnStatus('error'));
//   }, []);

//   // 2. High-performance Joystick Logic
//   useEffect(() => {
//     const baseEl = baseRef.current;
//     const thumbEl = thumbRef.current;
//     const linText = linearTextRef.current;
//     const angText = angularTextRef.current;
    
//     if (!baseEl || !thumbEl) return;

//     let originX = 0;
//     let originY = 0;

//     function clampToCircle(dx: number, dy: number) {
//       const dist = Math.sqrt(dx * dx + dy * dy);
//       if (dist > MAX_OFFSET) {
//         const scale = MAX_OFFSET / dist;
//         return { x: dx * scale, y: dy * scale };
//       }
//       return { x: dx, y: dy };
//     }

//     function onStart(clientX: number, clientY: number) {
//       const rect = baseEl!.getBoundingClientRect();
//       originX = rect.left + rect.width / 2;
//       originY = rect.top + rect.height / 2;
//       thumbEl!.classList.add('active');
//       update(clientX, clientY, true);
//     }

//     function onMove(clientX: number, clientY: number) {
//       update(clientX, clientY, true);
//     }

//     function onEnd() {
//       thumbEl!.classList.remove('active');
//       thumbEl!.style.transform = `translate(-50%, -50%)`;
//       joyData.current = { linear: 0, angular: 0, active: false };
      
//       // Reset live text to 0
//       if (linText) linText.innerText = "0.00";
//       if (angText) angText.innerText = "0.00";
//     }

//     function update(clientX: number, clientY: number, active: boolean) {
//       const raw = { x: clientX - originX, y: clientY - originY };
//       const { x, y } = clampToCircle(raw.x, raw.y);
      
//       // Update thumb visually
//       thumbEl!.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;

//       const linear = parseFloat((-y / MAX_OFFSET).toFixed(3));
//       const angular = parseFloat((x / MAX_OFFSET).toFixed(3));

//       // Update background data
//       joyData.current = { linear, angular, active };
      
//       // Update text values directly in the DOM (Fast!)
//       if (linText) linText.innerText = linear.toFixed(2);
//       if (angText) angText.innerText = angular.toFixed(2);
//     }

//     // Touch events
//     const onTouchStart = (e: TouchEvent) => { e.preventDefault(); onStart(e.touches[0].clientX, e.touches[0].clientY); };
//     const onTouchMove  = (e: TouchEvent) => { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); };
//     const onTouchEnd   = (e: TouchEvent) => { e.preventDefault(); onEnd(); };

//     // Mouse events (for desktop testing)
//     const onMouseDown = (e: MouseEvent) => onStart(e.clientX, e.clientY);
//     const onMouseMove = (e: MouseEvent) => { if (e.buttons === 1) onMove(e.clientX, e.clientY); };
//     const onMouseUp   = () => onEnd();

//     baseEl.addEventListener('touchstart',  onTouchStart, { passive: false });
//     baseEl.addEventListener('touchmove',   onTouchMove,  { passive: false });
//     baseEl.addEventListener('touchend',    onTouchEnd,   { passive: false });
    
//     baseEl.addEventListener('mousedown',   onMouseDown);
//     window.addEventListener('mousemove',   onMouseMove);
//     window.addEventListener('mouseup',     onMouseUp);

//     return () => {
//       baseEl.removeEventListener('touchstart',  onTouchStart);
//       baseEl.removeEventListener('touchmove',   onTouchMove);
//       baseEl.removeEventListener('touchend',    onTouchEnd);
      
//       baseEl.removeEventListener('mousedown',   onMouseDown);
//       window.removeEventListener('mousemove',   onMouseMove);
//       window.removeEventListener('mouseup',     onMouseUp);
//     };
//   }, []);

//   // 3. The 20Hz Publisher Loop
//   useEffect(() => {
//     const id = setInterval(() => {
//       if (!joyData.current.active) {
//         publishCmdVel(robotKey, 0, 0);
//       } else {
//         publishCmdVel(robotKey, joyData.current.linear, joyData.current.angular);
//       }
//     }, PUBLISH_RATE_MS);
    
//     return () => clearInterval(id);
//   }, [robotKey]);

//   return (
//     <div className="joystick-page">

//       {/* Restored Header Section */}
//       <div className="joystick-header">
//         <h1>ROBOT {robotNumber}</h1>
//         <div className={`connection-status ${connStatus}`}>
//           {connStatus === 'connecting' && 'connecting...'}
//           {connStatus === 'online'     && 'connected'}
//           {connStatus === 'error'      && 'connection failed'}
//         </div>
//       </div>

//       <div className="joystick-area">
//         <div className="joystick-base" ref={baseRef}>
//           <div className="joystick-thumb" ref={thumbRef} style={{ transform: 'translate(-50%, -50%)' }} />
//         </div>
//       </div>

//       {/* Restored Live Values Section */}
//       <div className="joystick-values">
//         <div>linear&nbsp; <span ref={linearTextRef}>0.00</span></div>
//         <div>angular <span ref={angularTextRef}>0.00</span></div>
//       </div>

//     </div>
//   );
// }

//====================================================================
//====================================================================

// import { useEffect, useRef, useState } from 'react';
// import { publishCmdVel, startZenohSession } from './zenoh';
// import './Joystick.css';

// const PUBLISH_RATE_MS = 50; // 20 Hz
// const BASE_RADIUS = 130;    
// const THUMB_RADIUS = 40;    
// const MAX_OFFSET = BASE_RADIUS - THUMB_RADIUS;

// export default function Joystick() {
//   const robotNumber = 1; // Assuming 1 for simplicity here
//   const robotKey    = `robot${robotNumber}`;

//   const [connStatus, setConnStatus] = useState<'connecting' | 'online' | 'error'>('connecting');
  
//   // 1. Create Refs for the DOM elements
//   const baseRef = useRef<HTMLDivElement>(null);
//   const thumbRef = useRef<HTMLDivElement>(null);

//   // 2. Store the math values in a Ref so updating them doesn't trigger a React render
//   const joyData = useRef({ linear: 0, angular: 0, active: false });

//   useEffect(() => {
//     startZenohSession()
//       .then(() => setConnStatus('online'))
//       .catch(() => setConnStatus('error'));
//   }, []);

//   // 3. The high-performance Joystick logic
//   useEffect(() => {
//     const baseEl = baseRef.current;
//     const thumbEl = thumbRef.current;
//     if (!baseEl || !thumbEl) return;

//     let originX = 0;
//     let originY = 0;

//     function clampToCircle(dx: number, dy: number) {
//       const dist = Math.sqrt(dx * dx + dy * dy);
//       if (dist > MAX_OFFSET) {
//         const scale = MAX_OFFSET / dist;
//         return { x: dx * scale, y: dy * scale };
//       }
//       return { x: dx, y: dy };
//     }

//     function onStart(clientX: number, clientY: number) {
//       const rect = baseEl!.getBoundingClientRect();
//       originX = rect.left + rect.width / 2;
//       originY = rect.top + rect.height / 2;
//       thumbEl!.classList.add('active'); // Update CSS class directly
//       update(clientX, clientY, true);
//     }

//     function onMove(clientX: number, clientY: number) {
//       update(clientX, clientY, true);
//     }

//     function onEnd() {
//       thumbEl!.classList.remove('active');
//       thumbEl!.style.transform = `translate(-50%, -50%)`; // Reset position
//       joyData.current = { linear: 0, angular: 0, active: false };
//     }

//     function update(clientX: number, clientY: number, active: boolean) {
//       const raw = { x: clientX - originX, y: clientY - originY };
//       const { x, y } = clampToCircle(raw.x, raw.y);
      
//       // Update DOM visually without triggering React state
//       thumbEl!.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;

//       // Update background data for Zenoh publisher
//       joyData.current = {
//         linear:  parseFloat((-y / MAX_OFFSET).toFixed(3)),
//         angular: parseFloat(( x / MAX_OFFSET).toFixed(3)),
//         active
//       };
//     }

//     // Touch Events
//     const onTouchStart = (e: TouchEvent) => { e.preventDefault(); onStart(e.touches[0].clientX, e.touches[0].clientY); };
//     const onTouchMove  = (e: TouchEvent) => { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); };
//     const onTouchEnd   = (e: TouchEvent) => { e.preventDefault(); onEnd(); };

//     baseEl.addEventListener('touchstart',  onTouchStart, { passive: false });
//     baseEl.addEventListener('touchmove',   onTouchMove,  { passive: false });
//     baseEl.addEventListener('touchend',    onTouchEnd,   { passive: false });

//     return () => {
//       baseEl.removeEventListener('touchstart',  onTouchStart);
//       baseEl.removeEventListener('touchmove',   onTouchMove);
//       baseEl.removeEventListener('touchend',    onTouchEnd);
//     };
//   }, []);

//   // 4. The 20Hz Publisher Loop
//   useEffect(() => {
//     // This interval now runs smoothly because the main thread isn't choked by React
//     const id = setInterval(() => {
//       if (!joyData.current.active) {
//         publishCmdVel(robotKey, 0, 0);
//       } else {
//         publishCmdVel(robotKey, joyData.current.linear, joyData.current.angular);
//       }
//     }, PUBLISH_RATE_MS);
    
//     return () => clearInterval(id);
//   }, [robotKey]);

//   return (
//     <div className="joystick-page">
//       <div className="joystick-area">
//         <div className="joystick-base" ref={baseRef}>
//           {/* Note the thumb now uses a ref instead of inline React styles */}
//           <div className="joystick-thumb" ref={thumbRef} style={{ transform: 'translate(-50%, -50%)' }} />
//         </div>
//       </div>
//     </div>
//   );
// }

//===========================================================================
//===========================================================================

// // Joystick.tsx
// // Mobile joystick controller for a single robot.
// // Reads ?robot=N from the URL, publishes robot<N>/cmd_vel at 20 Hz while active.

// import { useEffect, useRef, useState } from 'react';
// import { publishCmdVel, startZenohSession } from './zenoh';
// import './Joystick.css';

// const PUBLISH_RATE_MS = 50; // 20 Hz
// const BASE_RADIUS = 130;    // half of the 260px base diameter
// const THUMB_RADIUS = 40;    // half of the 80px thumb diameter
// const MAX_OFFSET = BASE_RADIUS - THUMB_RADIUS;

// function getRobotNumber(): number {
//   const params = new URLSearchParams(window.location.search);
//   const n = parseInt(params.get('robot') ?? '1');
//   return isNaN(n) ? 1 : n;
// }

// // ── useJoystick ───────────────────────────────────────────
// // Tracks pointer events on the base element.
// // Returns { offsetX, offsetY } clamped to the base circle,
// // and { linear, angular } normalised to [-1, 1].

// interface JoystickState {
//   offsetX: number;   // px, for thumb position
//   offsetY: number;   // px, for thumb position
//   linear: number;    // [-1, 1]  forward/backward
//   angular: number;   // [-1, 1]  left/right
//   active: boolean;
// }

// function useJoystick(baseRef: React.RefObject<HTMLDivElement | null>) {
//   const [state, setState] = useState<JoystickState>({
//     offsetX: 0, offsetY: 0, linear: 0, angular: 0, active: false,
//   });

//   useEffect(() => {
//     const el = baseRef.current;
//     if (!el) return;

//     let originX = 0;
//     let originY = 0;

//     function clampToCircle(dx: number, dy: number) {
//       const dist = Math.sqrt(dx * dx + dy * dy);
//       if (dist > MAX_OFFSET) {
//         const scale = MAX_OFFSET / dist;
//         return { x: dx * scale, y: dy * scale };
//       }
//       return { x: dx, y: dy };
//     }

//     function onStart(clientX: number, clientY: number) {
//       const rect = el!.getBoundingClientRect();
//       originX = rect.left + rect.width / 2;
//       originY = rect.top + rect.height / 2;
//       update(clientX, clientY, true);
//     }

//     function onMove(clientX: number, clientY: number) {
//       update(clientX, clientY, true);
//     }

//     function onEnd() {
//       setState({ offsetX: 0, offsetY: 0, linear: 0, angular: 0, active: false });
//     }

//     function update(clientX: number, clientY: number, active: boolean) {
//       const raw = { x: clientX - originX, y: clientY - originY };
//       const { x, y } = clampToCircle(raw.x, raw.y);
//       setState({
//         offsetX: x,
//         offsetY: y,
//         linear:  parseFloat((-y / MAX_OFFSET).toFixed(3)),  // up = positive linear
//         angular: parseFloat(( x / MAX_OFFSET).toFixed(3)),  // right = positive angular
//         active,
//       });
//     }

//     // Touch
//     const onTouchStart = (e: TouchEvent) => { e.preventDefault(); onStart(e.touches[0].clientX, e.touches[0].clientY); };
//     const onTouchMove  = (e: TouchEvent) => { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); };
//     const onTouchEnd   = (e: TouchEvent) => { e.preventDefault(); onEnd(); };

//     // Mouse (useful for desktop testing)
//     const onMouseDown = (e: MouseEvent) => onStart(e.clientX, e.clientY);
//     const onMouseMove = (e: MouseEvent) => { if (e.buttons === 1) onMove(e.clientX, e.clientY); };
//     const onMouseUp   = () => onEnd();

//     el.addEventListener('touchstart',  onTouchStart, { passive: false });
//     el.addEventListener('touchmove',   onTouchMove,  { passive: false });
//     el.addEventListener('touchend',    onTouchEnd,   { passive: false });
//     el.addEventListener('mousedown',   onMouseDown);
//     window.addEventListener('mousemove', onMouseMove);
//     window.addEventListener('mouseup',   onMouseUp);

//     return () => {
//       el.removeEventListener('touchstart',  onTouchStart);
//       el.removeEventListener('touchmove',   onTouchMove);
//       el.removeEventListener('touchend',    onTouchEnd);
//       el.removeEventListener('mousedown',   onMouseDown);
//       window.removeEventListener('mousemove', onMouseMove);
//       window.removeEventListener('mouseup',   onMouseUp);
//     };
//   }, [baseRef]);

//   return state;
// }

// // ── Joystick component ────────────────────────────────────

// export default function Joystick() {
//   const robotNumber = getRobotNumber();
//   const robotKey    = `robot${robotNumber}`;

//   const [connStatus, setConnStatus] = useState<'connecting' | 'online' | 'error'>('connecting');

//   const baseRef = useRef<HTMLDivElement>(null);
//   const joy     = useJoystick(baseRef);

//   // Open zenoh session once on mount
//   useEffect(() => {
//     startZenohSession()
//       .then(() => setConnStatus('online'))
//       .catch(() => setConnStatus('error'));
//   }, []);

//   // Publish at 20 Hz while joystick is active; send one final (0, 0) on release
//   useEffect(() => {
//     if (!joy.active) {
//       publishCmdVel(robotKey, 0, 0);
//       return;
//     }
//     const id = setInterval(() => {
//       publishCmdVel(robotKey, joy.linear, joy.angular);
//     }, PUBLISH_RATE_MS);
//     return () => clearInterval(id);
//   }, [joy.active, joy.linear, joy.angular, robotKey]);

//   // Thumb position as CSS transform
//   const thumbStyle = {
//     transform: `translate(calc(-50% + ${joy.offsetX}px), calc(-50% + ${joy.offsetY}px))`,
//   };

//   return (
//     <div className="joystick-page">

//       <div className="joystick-header">
//         <h1>ROBOT {robotNumber}</h1>
//         <div className={`connection-status ${connStatus}`}>
//           {connStatus === 'connecting' && 'connecting...'}
//           {connStatus === 'online'     && 'connected'}
//           {connStatus === 'error'      && 'connection failed'}
//         </div>
//       </div>

//       <div className="joystick-area">
//         <div className="joystick-base" ref={baseRef}>
//           <div className={`joystick-thumb ${joy.active ? 'active' : ''}`} style={thumbStyle} />
//         </div>
//       </div>

//       <div className="joystick-values">
//         <div>linear&nbsp; <span>{joy.linear.toFixed(2)}</span></div>
//         <div>angular <span>{joy.angular.toFixed(2)}</span></div>
//       </div>

//     </div>
//   );
// }