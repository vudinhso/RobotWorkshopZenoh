// zenoh.ts
// Single zenoh session shared across the app.
//
// Exports:
//   startZenohSession()        — open session once (idempotent)
//   startZenohSubscription(...) — subscribe to exact topic (dashboard/timer)
//   publishCmdVel(key, l, a)   — publish cmd_vel JSON (joystick)

import { Session, Config } from '@eclipse-zenoh/zenoh-ts';

const ZENOH_WS = `ws://${window.location.hostname}:10000`;

// ── Session singleton ─────────────────────────────────────
let session: Session | null = null;
 
export async function startZenohSession(): Promise<Session> {
  if (session) return session;
  session = await Session.open(new Config(ZENOH_WS));
  console.log(`[zenoh] session opened via ${ZENOH_WS}`);
  return session;
}

// ── Dashboard/Timer: subscribe to state ───────────────────

type StateCallback = (robotId: number, uptime_s: number) => void;
type RawCallback = (payload: string, key: string) => void;

interface ZenohSampleLike {
  keyexpr(): unknown;
  payload(): {
    toBytes(): Uint8Array;
  };
}

function parsePayload(sample: ZenohSampleLike): number | null {
  const raw = new TextDecoder().decode(sample.payload().toBytes()).replace(/\0/g, '');
  
  try {
    const data = JSON.parse(raw);
    
    // THE FIX: Check if the payload was just a raw number (e.g., "12345")
    if (typeof data === 'number') {
      return data; 
    }
    
    // Otherwise, assume it was a JSON object like {"uptime_s": 12345}
    return data.uptime_s ?? null;
    
  } catch {
    // Ultimate fallback just in case
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  }
}

function sampleToString(sample: ZenohSampleLike): string {
  return new TextDecoder().decode(sample.payload().toBytes()).replace(/\0/g, '');
}

export async function startZenohSubscription(
  topic: string, 
  onStateUpdate: StateCallback
): Promise<() => void> {
  
  // CRITICAL FIX: Do not open a new session! 
  // Use the global singleton session we already opened for the joystick.
  if (!session) {
    console.error("[zenoh] Cannot subscribe: Session is not initialized.");
    return () => {};
  }

  try {
    const subscriber = await session.declareSubscriber(topic, {
        handler: (sample: ZenohSampleLike) => {
        const key = String(sample.keyexpr());
        
        console.log(`[zenoh] RAW received -> Key: ${key}`);

        // const match = key.match(/robot(\d+)\/state/);
        const match = key.match(/robot\/(\d+)\/state/);
        if (!match) return;

        const robotId = parseInt(match[1]);
        const uptime_raw = parsePayload(sample);

        if (uptime_raw !== null) {
          const uptime_s = Math.floor(uptime_raw); 
          onStateUpdate(robotId, uptime_s);
        }
      },
    });

    console.log(`[zenoh] subscribed to exact topic: ${topic}`);

    return () => {
      subscriber.undeclare();
      // Notice we DO NOT close the session here anymore, 
      // otherwise leaving the page would kill the joystick!
    };

  } catch (error) {
    console.error(`[zenoh] failed to connect or subscribe:`, error);
    return () => {}; 
  }
}

export async function startZenohRawSubscription(
  topic: string,
  onMessage: RawCallback,
): Promise<() => void> {
  if (!session) {
    console.error("[zenoh] Cannot subscribe: Session is not initialized.");
    return () => {};
  }

  try {
    const subscriber = await session.declareSubscriber(topic, {
      handler: (sample: ZenohSampleLike) => {
        onMessage(sampleToString(sample), String(sample.keyexpr()));
      },
    });

    console.log(`[zenoh] subscribed to exact topic: ${topic}`);

    return () => {
      subscriber.undeclare();
    };
  } catch (error) {
    console.error(`[zenoh] failed to subscribe to ${topic}:`, error);
    return () => {};
  }
}

// ── Joystick: publish cmd_vel ─────────────────────────────
 
// Payload format: {"linear": 0.5, "angular": -0.2}
export async function publishCmdVel(
  robotKey: string,  // e.g. "robot3"
  linear: number,
  angular: number,
): Promise<void> {
  if (!session) return;
  const payload = JSON.stringify({ linear, angular });
  await session.put(`${robotKey}/cmd_vel`, payload);
}

export async function publishAdminEnable(
  robotKey: string,
  enabled: boolean,
): Promise<void> {
  if (!session) return;
  await session.put(`${robotKey}/admin_enable`, enabled ? '1' : '0');
}

export async function publishRawValue(
  topic: string,
  value: string,
): Promise<void> {
  if (!session) return;
  await session.put(topic, value);
}

//=======================================================
//=======================================================

// // zenoh.ts
// // Single zenoh session shared across the app.
// //
// // Exports:
// //   startZenohSession()        — open session once (idempotent)
// //   startZenohSubscription(cb) — subscribe to robot*/state (dashboard)
// //   publishCmdVel(key, l, a)   — publish cmd_vel JSON (joystick)

// import { Session, Config } from '@eclipse-zenoh/zenoh-ts';
// import type { Sample } from '@eclipse-zenoh/zenoh-ts';

// // const ZENOH_WS = `ws://${window.location.hostname}:7447`;
// const ZENOH_WS = `ws://${window.location.hostname}:10000`;

// // ── Session singleton ─────────────────────────────────────
// let session: Session | null = null;
 
// export async function startZenohSession(): Promise<Session> {
//   if (session) return session;
//   session = await Session.open(new Config(ZENOH_WS));
//   console.log(`[zenoh] session opened via ${ZENOH_WS}`);
//   return session;
// }

// // ── Dashboard: subscribe to robot*/state ─────────────────

// type StateCallback = (robotId: number, uptime_s: number) => void;

// function parsePayload(sample: any): number | null {
//   const raw = new TextDecoder().decode(sample.payload().toBytes()).replace(/\0/g, '');
//   try {
//     const data = JSON.parse(raw);
//     return data.uptime_s ?? null;
//   } catch {
//     const n = parseFloat(raw);
//     return isNaN(n) ? null : n;
//   }
// }

// // NEW: Added `topic: string` as the first argument
// export async function startZenohSubscription(
//   topic: string, 
//   onStateUpdate: StateCallback
// ): Promise<() => void> {
//   try {
//     const session = await Session.open(new Config(ZENOH_WS));

//     // NEW: Use the exact topic passed in, no wildcards needed!
//     const subscriber = await session.declareSubscriber(topic, {
//       handler: (sample: any) => {
//         // const key = sample.keyexpr.toString();
//         const key = String(sample.keyexpr());
        
//         console.log(`[zenoh] RAW received -> Key: ${key}`);

//         // Extract the robot ID from strings like "robot1/state"
//         const match = key.match(/robot(\d+)\/state/);
//         if (!match) return;

//         const robotId = parseInt(match[1]);
//         const uptime_raw = parsePayload(sample);

//         if (uptime_raw !== null) {
//           const uptime_s = Math.floor(uptime_raw / 1000); 
//           onStateUpdate(robotId, uptime_s);
//         }
//       },
//     });

//     console.log(`[zenoh] subscribed to exact topic: ${topic}`);

//     return () => {
//       subscriber.undeclare();
//       session.close();
//     };

//   } catch (error) {
//     console.error(`[zenoh] failed to connect or subscribe:`, error);
//     return () => {}; 
//   }
// }

// // type StateCallback = (robotId: number, uptime_s: number) => void;

// // function parsePayload(sample: Sample): number | null {
// //   const raw = new TextDecoder().decode(sample.payload().toBytes());

// //   // Accept either {"uptime_s": 142} or a plain number
// //   try {
// //     const data = JSON.parse(raw);
// //     return data.uptime_s ?? null;
// //   } catch {
// //     const n = parseFloat(raw);
// //     return isNaN(n) ? null : n;
// //   }
// // }

// // export async function startZenohSubscription(onStateUpdate: StateCallback): Promise<void> {
// //   const session = await Session.open(new Config(ZENOH_WS));

// //   await session.declareSubscriber('robot*/state', {
// //     handler: (sample: Sample) => {
// //       const key = sample.keyexpr.toString();

// //       const match = key.match(/^robot(\d+)\/state$/);
// //       if (!match) return;

// //       const robotId = parseInt(match[1]);
// //       const uptime_s = parsePayload(sample);

// //       if (uptime_s !== null) {
// //         onStateUpdate(robotId, uptime_s);
// //       }
// //     },
// //   });

// //   console.log(`[zenoh] subscribed to robot*/state via ${ZENOH_WS}`);
// // }

// // ── Joystick: publish cmd_vel ─────────────────────────────
 
// // Payload format: {"linear": 0.5, "angular": -0.2}
// // Matches what the ESP32 deserializes with ArduinoJson.
 
// export async function publishCmdVel(
//   robotKey: string,  // e.g. "robot3"
//   linear: number,
//   angular: number,
// ): Promise<void> {
//   if (!session) return;
//   const payload = JSON.stringify({ linear, angular });
//   await session.put(`${robotKey}/cmd_vel`, payload);
// }
