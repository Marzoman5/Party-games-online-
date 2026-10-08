/** package.json "version", injected at build time (vite.config.ts). Shown small on the title / join screens. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** 'rtc' for the static site (WebRTC, the host page is the server); default WebSocket to the Node server. */
  readonly VITE_TRANSPORT?: string;
  /** WebRTC settings, see src/net/rtc/config.ts. */
  readonly VITE_ICE_SERVERS?: string;
  readonly VITE_PEERJS?: string;
  readonly VITE_NOSTR?: string;
}
