export const MAX_SECONDS = 120 * 60;
export function formatTime(seconds) {
  const value = Math.max(0, Math.min(MAX_SECONDS, Math.floor(Number(seconds) || 0)));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
export function nextCue(seconds) {
  const current = Math.max(0, Number(seconds) || 0);
  if (current >= MAX_SECONDS) return '120분 안내 · 수고하셨습니다';
  const next = (Math.floor(current / 30) + 1) * 30;
  const remaining = Math.max(1, Math.ceil(next - current));
  return next % 60 === 0 ? `${remaining}초 후 “${next / 60}분”` : `${remaining}초 후 짧은 알림음`;
}
export function readVolume(value) {
  if (value === null || value === undefined || value === '') return 70;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 70;
}
