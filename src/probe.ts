import { command } from './util.js';

type Fact<T> = { value: T | null; source: string; diagnostic?: string };
export async function probeLocal(run = command, platform = process.platform) {
  async function observe<T>(argv: string[], parse: (text: string) => T): Promise<Fact<T>> {
    try { const result = await run(argv); if (result.code) throw new Error(result.stderr || `exit ${result.code}`); return { value: parse(result.stdout), source: argv.join(' ') }; }
    catch (error) { return { value: null, source: argv.join(' '), diagnostic: String(error) }; }
  }
  const permissions = await observe(['cua-driver', 'permissions', 'status', '--json'], JSON.parse);
  const recorder = await observe(['cua-driver', 'call', 'get_recording_state', '--json', '{}'], JSON.parse);
  const foreground = await observe(['cua-driver', 'call', 'list_apps', '--json', '{}'], text => {
    const data = JSON.parse(text); return data.apps?.filter((app: { active?: boolean }) => app.active).map((app: { name: string; bundle_id: string; pid: number }) => ({ name: app.name, bundleId: app.bundle_id, pid: app.pid })) ?? null;
  });
  const session = platform === 'darwin'
    ? await observe(['/usr/bin/stat', '-f', '%Su', '/dev/console'], text => !['root', 'loginwindow', ''].includes(text.trim()))
    : await observe(['loginctl', 'show-session', 'self', '-p', 'Active', '--value'], text => text.trim() === 'yes');
  const idle = platform === 'darwin'
    ? await observe(['/usr/sbin/ioreg', '-r', '-c', 'IOHIDSystem'], text => { const m = text.match(/"HIDIdleTime"\s*=\s*(\d+)/); return m ? Number(m[1]) / 1e9 : null; })
    : await observe(['xprintidle'], text => { const n = Number(text.trim()); return Number.isFinite(n) ? n / 1000 : null; });
  return {
    observedAt: new Date().toISOString(), permissions, recorder, foreground, userSessionActive: session,
    idleSeconds: { ...idle, formula: 'OS idle duration in nanoseconds / 1e9 (macOS), milliseconds / 1000 (X11)' },
    screenshot: { available: permissions.value?.screen_recording_capturable ?? null, permissionGranted: permissions.value?.screen_recording ?? null, note: 'Read-only probe: permission is not proof of capture; no screenshot or consent dialog is triggered.' },
  };
}
