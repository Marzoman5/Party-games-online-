/**
 * The room registry + relay logic lives in src/net/hub.ts so the static (WebRTC) build can run the
 * very same code inside the host page. Re-exported here for the server modules.
 */
export * from '../src/net/hub';
