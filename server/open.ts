/** Best-effort "open this URL in the default browser". Never throws. */
import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return; // headless
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // ignore
  }
}
